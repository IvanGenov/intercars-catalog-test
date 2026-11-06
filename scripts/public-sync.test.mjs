import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePublicJSONP,normalizePublicSnapshot,snapshotJavaScript,fetchPublicAPI} from './public-sync.mjs';
const photo='https://drive.google.com/thumbnail?id=1zNCNZkXoYzQeHsRNmTR1Muk7JvMVlWCo&sz=w1200';
const example=()=>({revision:'GATE02-DEMO-001',published_at:'46331.875',
  vehicles:[{id:'v-1',code:'AUTO-001',make:'VW',model:'Passat',year:2012,location_name:'Обект 1',sale_mode:'parts',status:'active',asking_price_eur:null,condition_text:'Тест',engine:'2.0 TDI',gearbox:'Ръчна',admin_email:'SECRET',received_amount_eur:888}],
  parts:[{id:'p-1',vehicle_id:'v-1',name_text:'фар',status:'available',asking_price_eur:95,notes_public:''}],
  photos:[{vehicle_id:'v-1',photo_id:'photo-1',url:photo,sort_order:1,is_cover:true}],
  sales:[{received_amount_eur:999}],admins:[{email:'hidden@example.com'}]
});
const wrap=x=>'window.__intercarsDataReady('+JSON.stringify(x)+');';
test('parse exact fixed JSONP, never execute arbitrary JS',()=>{
  const obj=parsePublicJSONP(wrap(example())); assert.equal(obj.revision,'GATE02-DEMO-001');
  assert.throws(()=>parsePublicJSONP('alert(1);'+wrap(example())),/API_RESPONSE_NOT_EXPECTED_CALLBACK/);
  assert.throws(()=>parsePublicJSONP('window.__intercarsDataReady({});alert(1);'),/API_RESPONSE_JSON_INVALID/);
});
test('only approved public fields survive, serial date ignored',()=>{
  const s=normalizePublicSnapshot(example());
  const text=snapshotJavaScript(s);
  assert.equal(s.published_at,null);
  for(const secret of ['received_amount_eur','admin_email','hidden@example.com','"sales"','"admins"']) assert.equal(text.includes(secret),false);
  assert.equal(s.photos.length,1);
});
test('HTML-injection strings safely escaped in generated JavaScript',()=>{
  const x=example();x.vehicles[0].condition_text='</script><script>alert(1)</script> & test';
  const txt=snapshotJavaScript(normalizePublicSnapshot(x));
  assert.equal(txt.includes('</script>'),false); assert.ok(txt.includes('\\u003c'));
});
test('reject empty snapshot and missing referenced vehicles',()=>{
  const x=example();x.vehicles=[];
  assert.throws(()=>normalizePublicSnapshot(x),/EMPTY_VEHICLE/);
  const y=example();y.photos[0].vehicle_id='other';
  assert.throws(()=>normalizePublicSnapshot(y),/ORPHAN_PHOTO/);
});
test('reject duplicate cover and unsafe image hosts',()=>{
  const x=example();x.photos.push({...x.photos[0],photo_id:'photo-2'});
  assert.throws(()=>normalizePublicSnapshot(x),/MULTIPLE_COVERS/);
  const y=example();y.photos[0].url='https://evil.example/thumbnail?id=abcdefghijabcdefghij';
  assert.throws(()=>normalizePublicSnapshot(y),/PHOTO_URL_NOT_APPROVED/);
});
test('reject invalid price, status, and IDs',()=>{
  const x=example();x.vehicles[0].asking_price_eur=-300;
  assert.throws(()=>normalizePublicSnapshot(x),/INVALID_vehicle_price/);
  const y=example();y.vehicles[0].sale_mode='secret';
  assert.throws(()=>normalizePublicSnapshot(y),/INVALID_sale_mode/);
  const z=example();z.vehicles[0].id='</script>';
  assert.throws(()=>normalizePublicSnapshot(z),/INVALID_vehicle_id/);
});
test('accept a valid public Apps Script callback via a fake HTTP response',async()=>{
  const payload=wrap(example());
  const fake=async()=>({ok:true,url:'https://script.googleusercontent.com/macros/echo',body:(async function*(){yield Buffer.from(payload);})()});
  const data=await fetchPublicAPI(undefined,fake);
  assert.equal(data.vehicles.length,1);
  assert.equal(data.parts[0].name_text,'фар');
});
test('reject non-approved redirected hosts without publishing',async()=>{
  const fake=async()=>({ok:true,url:'https://accounts.google.com/Login',body:(async function*(){yield Buffer.from(wrap(example()));})()});
  await assert.rejects(fetchPublicAPI(undefined,fake),/API_REDIRECT_NOT_APPROVED/);
});
test('reject an HTML login page instead of valid callback',()=>{
  assert.throws(()=>parsePublicJSONP('<html>login</html>'),/API_RESPONSE_NOT_EXPECTED_CALLBACK/);
});