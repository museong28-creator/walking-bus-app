import test from 'node:test';
import assert from 'node:assert/strict';
import {createNavigationService,createNavigationServer,normalizeWalk,normalizeArrivals,normalizeStops} from '../server/navigation-api.mjs';
const start=[37.5,127],end=[37.5005,127.0005];
const walk={status:'OK',route:{properties:{totalDistance:90,totalTime:100},legs:[{steps:[{properties:{guidance:'직진'},path:{points:[[127,37.5],[127.0005,37.5005]]}}]}]}};
const tago=items=>({response:{header:{resultCode:'00'},body:{items:items.length?{item:items}:'',totalCount:items.length}}});
const response=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
const arrival={routeid:'R1',routeno:'101',arrtime:'300',arrprevstationcnt:'4'};
test('Kakao route preserves actual geometry, guidance, and personal-ETA distance',()=>{
  const value=normalizeWalk(walk,start,end);assert.deepEqual(value.points,[start,end]);assert.equal(value.distance,90);assert.equal(value.steps[0].guidance,'직진');assert.equal(value.snapDistance,0);
});
test('route rejects missing/no-route/invalid/distant geometry rather than displaying straight-line ETA',()=>{
  assert.throws(()=>normalizeWalk({status:'END_LINK_NOT_FOUND'},start,end),/도보 경로/);
  assert.throws(()=>normalizeWalk({status:'OK'},start,end));
  assert.throws(()=>normalizeWalk({status:'SERVER_ERROR'},start,end),{code:'PROVIDER_UNAVAILABLE'});
  assert.throws(()=>normalizeWalk(walk,[0,0],end),/100m/);
  const copy=structuredClone(walk);copy.route.legs[0].steps[0].path.points[0]=[NaN,37];assert.throws(()=>normalizeWalk(copy,start,end));
});
test('arrivals distinguish estimated, no-data, invalid and upstream failures',()=>{
  const value=normalizeArrivals(tago([arrival]),1000);assert.equal(value.arrivals[0].etaSeconds,300);assert.equal(value.status,'estimated');assert.equal(value.expiresAt,'1970-01-01T00:00:31.000Z');
  assert.equal(normalizeArrivals(tago([]),1000).status,'no_data');
  for(const arrtime of ['',null,-1,'x'])assert.throws(()=>normalizeArrivals(tago([{...arrival,arrtime}]),1000));
  assert.throws(()=>normalizeArrivals({response:{header:{resultCode:'30'}}},1000));
  assert.throws(()=>normalizeArrivals({response:{header:{resultCode:'00'},body:{}}},1000));
});
test('stops retain authoritative city/id, reject bad coords, indicate truncation',()=>{
  const data=tago([{nodeid:'DJB1',citycode:25,nodenm:'정류장',gpslati:'36.3',gpslong:'127.3'}]);
  data.response.body.totalCount=120;
  const result=normalizeStops(data);assert.equal(result.stops[0].cityCode,'25');assert.equal(result.truncated,true);
  data.response.body.items.item[0].gpslati='';assert.throws(()=>normalizeStops(data));
});
test('missing credentials and invalid inputs make no upstream calls',async()=>{
  let calls=0;const api=createNavigationService({reserveQuota:async()=>true,fetchImpl:()=>{calls++;throw Error();}});
  await assert.rejects(api.request('/v1/walk',{start,end}),{code:'NOT_CONFIGURED'});
  await assert.rejects(api.request('/v1/stops',{point:start}),{code:'NOT_CONFIGURED'});
  for(const input of [{start,end,mode:'UNSAFE'},{start:[null,127],end}])await assert.rejects(api.request('/v1/walk',input),{code:'INVALID_INPUT'});
  await assert.rejects(api.request('/v1/arrivals',{cityCode:'25',stopId:'../../evil'}),{code:'INVALID_INPUT'});assert.equal(calls,0);
});
test('Kakao secret is only upstream auth; coordinates and mode use official schema',async()=>{
  let seen;const api=createNavigationService({reserveQuota:async()=>true,kakaoKey:'fixture-secret',fetchImpl:async(url,options)=>{seen={url,options};return response(walk);}});
  const result=await api.request('/v1/walk',{start,end,mode:'ACCESSIBLE'});
  assert.equal(seen.url.origin,'https://dapi.kakao.com');assert.equal(seen.url.pathname,'/v2/routing/walk');assert.equal(seen.url.searchParams.get('start_x'),'127');assert.equal(seen.url.searchParams.get('route_mode'),'ACCESSIBLE');assert.equal(seen.options.headers.Authorization,'KakaoAK fixture-secret');assert.equal(seen.options.redirect,'error');assert.ok(!JSON.stringify(result).includes('fixture-secret'));
});
test('TAGO requests use official operation, encode decoded key once and cache arrivals for 15s',async()=>{
  let now=1000,calls=[];const api=createNavigationService({reserveQuota:async()=>true,tagoKey:'a+b/=test',now:()=>now,fetchImpl:async(url)=>{calls.push(url);return response(tago([arrival]));}});
  const input={cityCode:'25',stopId:'DJB1'};const first=await api.request('/v1/arrivals',input);now+=1000;
  const second=await api.request('/v1/arrivals',input);assert.equal(calls.length,1);assert.equal(second.cached,true);assert.equal(first.fetchedAt,second.fetchedAt);assert.equal(calls[0].searchParams.get('serviceKey'),'a+b/=test');assert.match(calls[0].pathname,/getSttnAcctoArvlPrearngeInfoList$/);
  now+=16000;await api.request('/v1/arrivals',input);assert.equal(calls.length,2);
});
test('quota caps calls and network/provider errors never leak URL or secret',async()=>{
  const api=createNavigationService({reserveQuota:async()=>true,kakaoKey:'fixture-secret',maxDailyCalls:1,fetchImpl:async()=>{throw Error('fixture-secret full upstream URL');}});
  await assert.rejects(api.request('/v1/walk',{start,end}),e=>e.code==='PROVIDER_UNAVAILABLE'&&!e.message.includes('fixture-secret'));
  await assert.rejects(api.request('/v1/walk',{start,end}),{code:'LOCAL_QUOTA'});
});
test('large/non-JSON upstream response is rejected safely',async()=>{
  for(const mock of [new Response('not-json'),new Response('x'.repeat(2000001))]){
    const api=createNavigationService({reserveQuota:async()=>true,kakaoKey:'fixture',fetchImpl:async()=>mock});await assert.rejects(api.request('/v1/walk',{start,end}),{code:'PROVIDER_UNAVAILABLE'});
  }
});
test('HTTP API enforces origin, method, JSON body, no query credentials and returns no-store',async t=>{
  let calls=0;const server=createNavigationServer({authorize:async()=>({uid:'test-user'}),allowedOrigins:['https://example.test'],service:{request:async()=>{calls++;return {ok:true};}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const base=`http://127.0.0.1:${server.address().port}`;
  const request=(path='/v1/walk',options={})=>fetch(base+path,{method:'POST',headers:{Origin:'https://example.test','Content-Type':'application/json'},body:'{}',...options});
  assert.equal((await request('/v1/walk',{headers:{Origin:'https://evil.test','Content-Type':'application/json'}})).status,403);
  assert.equal((await request('/v1/walk?key=secret')).status,404);
  assert.equal((await request('/v1/walk',{body:'{'})).status,400);
  assert.equal((await request('/v1/walk',{headers:{Origin:'https://example.test','Content-Type':'text/plain'}})).status,415);
  const good=await request();assert.equal(good.status,200);assert.equal(good.headers.get('cache-control'),'no-store');assert.equal(good.headers.get('access-control-allow-origin'),'https://example.test');assert.equal(calls,1);
});

// These are deliberate fixtures, not production authentication or storage.
test('provider calls fail closed without durable reservation and on storage errors',async()=>{
  for(const reserveQuota of [undefined,async()=>false,async()=>{throw Error('secret');}]){
    let calls=0;
    const api=createNavigationService({kakaoKey:'fixture',reserveQuota,fetchImpl:async()=>{calls++;return response(walk);}});
    await assert.rejects(api.request('/v1/walk',{start,end}),e=>['SECURITY_NOT_CONFIGURED','QUOTA_UNAVAILABLE'].includes(e.code));
    assert.equal(calls,0);
  }
});
test('spoofing allowed Origin cannot bypass authentication gate',async t=>{
  for(const authorize of [undefined,async()=>false,async()=>{throw Error('secret');}]){
    let calls=0;const server=createNavigationServer({authorize,allowedOrigins:['https://example.test'],service:{request:async()=>{calls++;return {};}}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    const result=await fetch(`http://127.0.0.1:${server.address().port}/v1/cities`,{method:'POST',headers:{Origin:'https://example.test','Content-Type':'application/json'},body:'{}'});
    assert.equal(result.status,authorize?401:503);assert.equal(calls,0);
    assert.ok(!(await result.text()).includes('secret'));
  }
});
test('only authenticated principal, not a client body UID, reaches quota reservation',async t=>{
  let reservedUid;
  const service=createNavigationService({kakaoKey:'fixture',reserveQuota:async({uid})=>{reservedUid=uid;return true;},fetchImpl:async()=>response(walk)});
  const server=createNavigationServer({service,allowedOrigins:['https://example.test'],authorize:async()=>({uid:'verified-owner'})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const result=await fetch(`http://127.0.0.1:${server.address().port}/v1/walk`,{method:'POST',headers:{Origin:'https://example.test','Content-Type':'application/json'},body:JSON.stringify({start,end,uid:'forged-user'})});
  assert.equal(result.status,200);assert.equal(reservedUid,'verified-owner');
});
test('authenticated session check reserves durable quota without provider keys or upstream calls',async()=>{
 let calls=0,uid;const api=createNavigationService({reserveQuota:async value=>{uid=value.uid;return true;},fetchImpl:()=>{calls++;}});
 assert.deepEqual(await api.request('/v1/session',{}, {uid:'owner'}),{authenticated:true,quotaReservation:true,liveNavigation:false});
 assert.equal(uid,'owner');assert.equal(calls,0);
 const locked=createNavigationService();await assert.rejects(locked.request('/v1/session'),{code:'SECURITY_NOT_CONFIGURED'});
});
