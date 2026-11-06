/**
 * Intercars GATE-02 — public-only snapshot publication.
 * Fetches an anonymous Apps Script JSONP endpoint on a trusted GitHub runner.
 * NEVER evaluates remote JavaScript, and NEVER copies private fields.
 * Failed reads/validation stop the Pages deploy, preserving the last live site.
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_PUBLIC_API_URL = 'https://script.google.com/macros/s/AKfycbxjkmPqyIEj-2B24HUDJuKqhrfhs51eHvHyOb8AXtjVYnQSqk0pAZqpv7hwoyf2HmL8XA/exec';
const SCRIPT_PREFIX = 'window.__intercarsDataReady(';
const MAX_BYTES = 2_000_000;
const MAX = { vehicles:250, parts:10000, photos:3000 };
const requireValue = (ok, msg) => { if (!ok) throw new Error(msg); };

export function parsePublicJSONP(source) {
  requireValue(typeof source === 'string' && source.length < MAX_BYTES, 'API_RESPONSE_SIZE_INVALID');
  const s = source.trim();
  requireValue(s.startsWith(SCRIPT_PREFIX) && s.endsWith(');'), 'API_RESPONSE_NOT_EXPECTED_CALLBACK');
  const inner = s.slice(SCRIPT_PREFIX.length, -2);
  let raw;
  try { raw = JSON.parse(inner); }
  catch { throw new Error('API_RESPONSE_JSON_INVALID'); } // remote JS is NEVER evaluated
  requireValue(raw && typeof raw === 'object' && !Array.isArray(raw), 'API_ROOT_INVALID');
  return raw;
}

function string(value, field, maxLength, required=false) {
  if (value == null && !required) return '';
  requireValue(typeof value === 'string', `INVALID_${field}`);
  const x = value.trim();
  requireValue(x.length <= maxLength && (!required || x.length > 0), `INVALID_${field}`);
  return x;
}
function id(value, field) {
  const x = string(value, field, 120, true);
  requireValue(/^[\p{L}\p{N}_.:-]+$/u.test(x), `INVALID_${field}`);
  return x;
}
function price(value, field) {
  if (value == null) return null;
  requireValue(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10000000,
    `INVALID_${field}`);
  return Math.round(value*100)/100;
}
function number(value, field, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  requireValue(Number.isInteger(n) && n>=min && n<=max, `INVALID_${field}`);
  return n;
}
function choice(value, field, values) {
  requireValue(values.includes(value), `INVALID_${field}`);
  return value;
}
function unique(array, field) {
  const ids = new Set();
  for (const x of array) {
    requireValue(!ids.has(x.id), `DUPLICATE_${field}`);
    ids.add(x.id);
  }
  return ids;
}
function publicDriveUrl(value) {
  const url = new URL(string(value,'photo_url',400,true));
  requireValue(url.protocol==='https:' && url.hostname === 'drive.google.com' && url.pathname === '/thumbnail',
    'PHOTO_URL_NOT_APPROVED');
  const fid = url.searchParams.get('id');
  requireValue(fid && /^[a-zA-Z0-9_-]{20,150}$/.test(fid), 'PHOTO_ID_NOT_APPROVED');
  return url.toString();
}
export function normalizePublicSnapshot(raw) {
  requireValue(raw && typeof raw === 'object' && !Array.isArray(raw), 'ROOT_INVALID');
  const revision=string(raw.revision,'revision',80,true);
  for (const key of ['vehicles','parts','photos']) {
    requireValue(Array.isArray(raw[key]) && raw[key].length<=MAX[key], `INVALID_${key.toUpperCase()}`);
  }
  requireValue(raw.vehicles.length>0, 'EMPTY_VEHICLE_SNAPSHOT_REFUSED');
  const vehicles=raw.vehicles.map(v => ({
    id:id(v.id,'vehicle_id'), code:string(v.code,'code',80,true),
    make:string(v.make,'make',90,true), model:string(v.model,'model',90,true),
    year:number(v.year,'year',1880,2100,null), location_name:string(v.location_name,'location',120),
    sale_mode:choice(v.sale_mode,'sale_mode',['whole','parts']),
    status:choice(v.status,'vehicle_status',['active','reserved','sold']),
    asking_price_eur:price(v.asking_price_eur,'vehicle_price'),
    condition_text:string(v.condition_text,'condition',1000),
    engine:string(v.engine,'engine',100), gearbox:string(v.gearbox,'gearbox',100)
  }));
  const vehicleIds=unique(vehicles,'VEHICLE_ID');
  const parts=raw.parts.map(p=>({
    id:id(p.id,'part_id'), vehicle_id:id(p.vehicle_id,'part_vehicle_id'),
    name_text:string(p.name_text,'part_name',160,true),
    status:choice(p.status,'part_status',['available','reserved','sold','unavailable']),
    asking_price_eur:price(p.asking_price_eur,'part_price'),
    notes_public:string(p.notes_public,'part_notes',500)
  }));
  unique(parts,'PART_ID');
  for(const p of parts) requireValue(vehicleIds.has(p.vehicle_id),'ORPHAN_PART');
  const photos=raw.photos.map(p=>({
    vehicle_id:id(p.vehicle_id,'photo_vehicle_id'),
    photo_id:id(p.photo_id,'photo_id'),
    url:publicDriveUrl(p.url),
    sort_order:number(p.sort_order,'photo_sort',0,1000000,999),
    is_cover:p.is_cover===true
  }));
  const photoIds=new Set();const coverByVehicle=new Set();
  for(const p of photos){
    requireValue(vehicleIds.has(p.vehicle_id),'ORPHAN_PHOTO');
    requireValue(!photoIds.has(p.photo_id),'DUPLICATE_PHOTO_ID'); photoIds.add(p.photo_id);
    if(p.is_cover){requireValue(!coverByVehicle.has(p.vehicle_id),'MULTIPLE_COVERS'); coverByVehicle.add(p.vehicle_id);}
  }
  // Sheets import can return a numeric Excel serial; omit it rather than publishing a false ISO date.
  const published_at=typeof raw.published_at==='string' && /^\d{4}-\d{2}-\d{2}T/.test(raw.published_at)
    && Number.isFinite(Date.parse(raw.published_at)) ? new Date(raw.published_at).toISOString() : null;
  return {revision,published_at,vehicles,parts,photos}; // explicit allowlist, NO sales / admins / secrets
}

export function snapshotJavaScript(snapshot) {
  // Executable output contains only JSON and a fixed callback, no remote JS.
  const json=JSON.stringify(snapshot)
    .replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026')
    .replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  return `/* Public-only Intercars snapshot, generated from approved data. */\nwindow.__intercarsDataReady(${json});\n`;
}
export async function fetchPublicAPI(url=DEFAULT_PUBLIC_API_URL, fetcher=fetch) {
  const u=new URL(url);
  requireValue(u.protocol==='https:' && u.hostname==='script.google.com'
    && /^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(u.pathname), 'API_URL_NOT_APPROVED');
  const response=await fetcher(url,{redirect:'follow',signal:AbortSignal.timeout(25000),headers:{'Accept':'text/javascript,application/javascript,text/plain'}});
  requireValue(response.ok,'API_HTTP_'+response.status);
  const final=new URL(response.url || url);
  requireValue(final.protocol==='https:' && ['script.google.com','script.googleusercontent.com'].includes(final.hostname),
    'API_REDIRECT_NOT_APPROVED_HOST_'+final.hostname);
  const pieces=[];let size=0;
  for await (const chunk of response.body) {
    size+=chunk.byteLength;
    requireValue(size<=MAX_BYTES,'API_RESPONSE_TOO_LARGE');
    pieces.push(Buffer.from(chunk));
  }
  return normalizePublicSnapshot(parsePublicJSONP(Buffer.concat(pieces).toString('utf8')));
}
export async function publishSite({root=process.cwd(),url=DEFAULT_PUBLIC_API_URL,fetcher=fetch}={}) {
  const data=await fetchPublicAPI(url,fetcher); // first: no files touched until valid
  const html=await readFile(join(root,'index.html'),'utf8');
  requireValue(html.includes("tag.src = snapshotSrc") && html.includes("./catalog-snapshot.js"), 'INDEX_NOT_SNAPSHOT_BASED');
  const dir=resolve(root,'_site');
  await mkdir(dir,{recursive:true});
  await writeFile(join(dir,'index.html'),html,'utf8');
  await writeFile(join(dir,'catalog-snapshot.js'),snapshotJavaScript(data),'utf8');
  return {vehicles:data.vehicles.length,parts:data.parts.length,photos:data.photos.length,revision:data.revision};
}
if(process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  publishSite({url:process.env.PUBLIC_API_URL||DEFAULT_PUBLIC_API_URL})
    .then(x=>console.log('Validated and prepared public Pages deployment:',JSON.stringify(x)))
    .catch(e=>{console.error('PUBLIC_SYNC_FAILED:',e.message);process.exitCode=1;});
}