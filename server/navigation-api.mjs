// Server-only adapters. Never import from src/ or include in the static build.
import http from 'node:http';
import {loadFirebaseSecurity} from './firebase-security.mjs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {isCoordinate, distance} from '../src/core.js';

export class NavigationError extends Error {
  constructor(status, code, message) { super(message); this.status=status; this.code=code; }
}
const fail=(status,code,message)=>{throw new NavigationError(status,code,message);};
const bad=()=>fail(400,'INVALID_INPUT','요청 값을 확인해 주세요.');
const unavailable=()=>fail(502,'PROVIDER_UNAVAILABLE','제공기관 응답을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.');
const numeric=v=>(typeof v==='number'||typeof v==='string')&&String(v).trim()!==''&&Number.isFinite(Number(v));
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(v);
const city=v=>typeof v==='string'&&/^\d{1,9}$/.test(v);
const modes=new Set(['BROAD_FIRST','SHORTEST','ACCESSIBLE']);
const bases={stops:'https://apis.data.go.kr/1613000/BusSttnInfoInqireService/',arrivals:'https://apis.data.go.kr/1613000/ArvlInfoInqireService/'};

export function normalizeWalk(data, start, end) {
  if(data?.status!=='OK'){
    if(['SAME_POINT','START_LINK_NOT_FOUND','END_LINK_NOT_FOUND','TOO_MANY_SEARCH_LINK','TOO_FAR_AWAY','ROUTE_RESULT_NOT_FOUND'].includes(data?.status)) fail(422,'NO_ROUTE','도보 경로를 찾지 못했어요. 출발지와 목적지를 확인해 주세요.');
    unavailable();
  }
  const props=data.route?.properties,legs=data.route?.legs;
  if(!Number.isFinite(props?.totalDistance)||props.totalDistance<=0||!Array.isArray(legs)||!legs.length) unavailable();
  const steps=[];
  for(const leg of legs){
    if(!Array.isArray(leg?.steps)||!leg.steps.length) unavailable();
    for(const step of leg.steps){
      if(!Array.isArray(step?.path?.points)||!step.path.points.length) unavailable();
      const points=step.path.points.map(p=>Array.isArray(p)&&p.length===2?[p[1],p[0]]:null);
      if(!points.every(isCoordinate)) unavailable();
      steps.push({points,guidance:String(step.properties?.guidance||'').slice(0,1000)});
    }
  }
  const points=steps.flatMap(s=>s.points).filter((p,i,all)=>i===0||p[0]!==all[i-1][0]||p[1]!==all[i-1][1]);
  if(points.length<2||points.length>50000) unavailable();
  const snapDistance=Math.max(distance(start,points[0]),distance(end,points.at(-1)));
  if(snapDistance>100) fail(422,'ROUTE_TOO_FAR','선택한 지점에서 100m 이내의 도보 경로를 찾지 못했어요.');
  return {points,distance:props.totalDistance,steps,source:'Kakao 도보 경로',snapDistance};
}
function tagoItems(data){
  const response=data?.response;
  if(String(response?.header?.resultCode)!=='00') unavailable();
  const items=response?.body?.items;
  if(items===''||items===null||items===undefined){
    if(Number(response?.body?.totalCount)===0)return [];
    unavailable();
  }
  const raw=items.item;
  if(raw===undefined||raw===null||raw===''){
    if(Number(response?.body?.totalCount)===0)return [];
    unavailable();
  }
  return Array.isArray(raw)?raw:[raw];
}
export function normalizeStops(data){
  const body=data?.response?.body;
  const stops=tagoItems(data).map(p=>{
    const point=numeric(p?.gpslati)&&numeric(p?.gpslong)?[Number(p.gpslati),Number(p.gpslong)]:null;
    if(!isCoordinate(point)||!id(String(p?.nodeid||''))||!city(String(p?.citycode||''))) unavailable();
    return {provider:'TAGO',id:String(p.nodeid),cityCode:String(p.citycode),name:String(p.nodenm||'정류장'),point};
  });
  return {stops,totalCount:Number(body.totalCount)||stops.length,truncated:Number(body.totalCount)>stops.length};
}
export function normalizeArrivals(data,now){
  const arrivals=tagoItems(data).map(p=>{
    if(!id(String(p?.routeid||''))||!numeric(p?.arrtime)||Number(p.arrtime)<0) unavailable();
    return {routeId:String(p.routeid),routeName:String(p.routeno??''),etaSeconds:Number(p.arrtime),remainingStops:numeric(p.arrprevstationcnt)&&Number(p.arrprevstationcnt)>=0?Number(p.arrprevstationcnt):null,status:'estimated'};
  });
  return {provider:'TAGO',status:arrivals.length?'estimated':'no_data',fetchedAt:new Date(now).toISOString(),expiresAt:new Date(now+30000).toISOString(),arrivals};
}

export function createNavigationService({kakaoKey='',tagoKey='',fetchImpl=fetch,now=Date.now,maxDailyCalls=100,timeoutMs=10000,reserveQuota}={}){
  if(!Number.isSafeInteger(maxDailyCalls)||maxDailyCalls<1||maxDailyCalls>1000) throw new Error('Invalid daily limit');
  let day='',calls=0,inflight=0;
  const cache=new Map();
  async function upstream(url,headers={},uid){
    const today=new Date(now()).toISOString().slice(0,10);
    if(today!==day){day=today;calls=0;}
    if(calls>=maxDailyCalls||inflight>=4)fail(429,'LOCAL_QUOTA','호출 제한에 도달했어요. 나중에 다시 시도해 주세요.');
    // The local counter is only a secondary limit. A durable backend must
    // atomically reserve before every provider request, including failed calls.
    if(typeof reserveQuota!=='function')fail(503,'SECURITY_NOT_CONFIGURED','서버 보호 설정이 완료되지 않았어요.');
    let reserved=false;
    try{reserved=await reserveQuota({day:today,limit:maxDailyCalls,uid});}catch{}
    if(reserved!==true)fail(503,'QUOTA_UNAVAILABLE','사용량 보호 상태를 확인할 수 없어 요청을 중단했어요.');
    // Recheck after awaiting storage to keep local concurrency bounded.
    if(calls>=maxDailyCalls||inflight>=4)fail(429,'LOCAL_QUOTA','호출 제한에 도달했어요. 나중에 다시 시도해 주세요.');
    calls++;inflight++;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const response=await fetchImpl(url,{headers,signal:controller.signal,redirect:'error'});
      if(!response.ok) unavailable();
      if(Number(response.headers.get('content-length'))>2000000) unavailable();
      // Bounded streaming read, including upstream responses without Content-Length.
      const reader=response.body.getReader();let chunks=[],size=0;
      try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>2000000){await reader.cancel();unavailable();}chunks.push(value);}}finally{reader.releaseLock();}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      return JSON.parse(new TextDecoder().decode(bytes));
    }catch(error){if(error instanceof NavigationError)throw error;unavailable();}
    finally{clearTimeout(timer);inflight--;}
  }
  async function tago(type,operation,params={},uid){
    if(!tagoKey)fail(503,'NOT_CONFIGURED','버스 정보 인증 설정이 필요해요.');
    const url=new URL(operation,bases[type]);
    // Supply the decoded service key via secret environment variable. URLSearchParams encodes once.
    url.search=new URLSearchParams({serviceKey:tagoKey,_type:'json',numOfRows:'100',pageNo:'1',...params});
    return upstream(url,{},uid);
  }
  return {async request(path,input={},principal={}){
    if(!input||typeof input!=='object'||Array.isArray(input))bad();
    if(path==='/v1/session'){
      if(typeof reserveQuota!=='function')fail(503,'SECURITY_NOT_CONFIGURED','서버 보호 설정이 완료되지 않았어요.');
      let reserved=false;
      try{reserved=await reserveQuota({day:new Date(now()).toISOString().slice(0,10),limit:maxDailyCalls,uid:principal.uid});}catch{}
      if(reserved!==true)fail(503,'QUOTA_UNAVAILABLE','사용량 보호 상태를 확인할 수 없어 요청을 중단했어요.');
      return {authenticated:true,quotaReservation:true,liveNavigation:false};
    }
    if(path==='/v1/walk'){
      const {start,end,mode='SHORTEST'}=input;
      if(!isCoordinate(start)||!isCoordinate(end)||!modes.has(mode))bad();
      if(!kakaoKey)fail(503,'NOT_CONFIGURED','도보 경로 인증 설정이 필요해요.');
      const url=new URL('https://dapi.kakao.com/v2/routing/walk');
      url.search=new URLSearchParams({start_x:String(start[1]),start_y:String(start[0]),end_x:String(end[1]),end_y:String(end[0]),route_mode:mode,input_coord:'WGS84',output_coord:'WGS84'});
      return normalizeWalk(await upstream(url,{Authorization:`KakaoAK ${kakaoKey}`},principal.uid),start,end);
    }
    if(path==='/v1/stops'){
      if(!isCoordinate(input.point))bad();
      return normalizeStops(await tago('stops','getCrdntPrxmtSttnList',{gpsLati:String(input.point[0]),gpsLong:String(input.point[1])},principal.uid));
    }
    if(path==='/v1/cities'){
      // Arrival-service cities, not an assumption of nationwide live coverage.
      const rows=tagoItems(await tago('arrivals','getCtyCodeList',{},principal.uid));
      return {cities:rows.map(p=>{if(!city(String(p?.citycode||'')))unavailable();return {code:String(p.citycode),name:String(p.cityname||'')};})};
    }
    if(path==='/v1/arrivals'){
      if(!city(input.cityCode)||!id(input.stopId))bad();
      const key=`${input.cityCode}:${input.stopId}`,cached=cache.get(key);
      if(cached&&now()-cached.time<15000)return {...cached.value,cached:true};
      const value=normalizeArrivals(await tago('arrivals','getSttnAcctoArvlPrearngeInfoList',{cityCode:input.cityCode,nodeId:input.stopId},principal.uid),now());
      if(cache.size>=100)cache.delete(cache.keys().next().value);
      cache.set(key,{time:now(),value});
      return {...value,cached:false};
    }
    fail(404,'NOT_FOUND','지원하지 않는 요청이에요.');
  }};
}

export function createNavigationServer({service=createNavigationService(),allowedOrigins=['http://localhost:3000','http://127.0.0.1:3000'],authorize}={}){
  const origins=new Set(allowedOrigins);
  if(!origins.size||origins.has('*')||[...origins].some(x=>{try{return new URL(x).origin!==x;}catch{return true;}}))throw new Error('Explicit origins required');
  const slots=new Map();
  return http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Vary','Origin');
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    try{
      const origin=req.headers.origin;
      if(!origins.has(origin))fail(403,'ORIGIN_DENIED','허용되지 않은 사이트예요.');
      res.setHeader('Access-Control-Allow-Origin',origin);
      if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','POST');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');res.writeHead(204);res.end();return;}
      if(req.method!=='POST')fail(405,'METHOD_NOT_ALLOWED','POST 요청만 지원해요.');
      if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))fail(415,'JSON_REQUIRED','JSON 요청이 필요해요.');
      if(!/^\/v1\/(walk|stops|arrivals|cities|session)$/.test(req.url))fail(404,'NOT_FOUND','지원하지 않는 요청이에요.');
      const now=Date.now(),ip=req.socket.remoteAddress;
      for(const [key,slot] of slots)if(now-slot.start>60000)slots.delete(key);
      const slot=slots.get(ip)||{start:now,count:0};
      if(slot.count>=20||slots.size>=1000&&!slots.has(ip))fail(429,'RATE_LIMIT','잠시 후 다시 시도해 주세요.');
      slot.count++;slots.set(ip,slot);
      // CORS is not authentication. No environment flag or shared browser key
      // bypasses this gate. Production must supply a verified session adapter.
      if(typeof authorize!=='function')fail(503,'SECURITY_NOT_CONFIGURED','서버 보호 설정이 완료되지 않았어요.');
      let authorized=false;
      try{authorized=await authorize(req);}catch{}
      if(!authorized||typeof authorized.uid!=='string')fail(401,'AUTH_REQUIRED','로그인이 필요해요.');
      let body='';for await(const chunk of req){body+=chunk.toString('utf8');if(Buffer.byteLength(body)>2048)fail(413,'BODY_TOO_LARGE','요청이 너무 커요.');}
      let input;try{input=JSON.parse(body);}catch{bad();}
      send(200,await service.request(req.url,input,authorized));
    }catch(error){const safe=error instanceof NavigationError?error:new NavigationError(500,'INTERNAL_ERROR','요청을 처리하지 못했어요.');send(safe.status,{error:{code:safe.code,message:safe.message}});}
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const origins=(process.env.NAV_ALLOWED_ORIGINS||'http://localhost:3000,http://127.0.0.1:3000').split(',').map(x=>x.trim());
  const security=await loadFirebaseSecurity();
  const service=createNavigationService({reserveQuota:security?.reserveQuota,kakaoKey:process.env.KAKAO_REST_API_KEY,tagoKey:process.env.TAGO_SERVICE_KEY,maxDailyCalls:Number(process.env.NAV_MAX_DAILY_CALLS||100)});
  const server=createNavigationServer({service,allowedOrigins:origins,authorize:security?.authorize});
  server.requestTimeout=15000;server.headersTimeout=10000;
  server.listen(Number(process.env.PORT||8788),process.env.NAV_HOST||'127.0.0.1',()=>console.log('Navigation API listening. No request bodies or upstream URLs are logged.'));
}
