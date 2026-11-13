import test from 'node:test';
import assert from 'node:assert/strict';

let moduleSequence = 0;
const start = [37.5665, 126.978];
const end = [37.57, 126.981];
const routePayload = () => ({
  code: 'Ok', routes: [{distance: 543.2, geometry: {coordinates: [[126.978, 37.5665], [126.981, 37.57]]}}],
  waypoints: [{distance: 2}, {distance: 4}],
});

async function fixture(t, payload, {ok = true, status = 200, implementation} = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({url: String(url), options});
    if (implementation) return implementation(url, options);
    return {ok, status, json: async () => payload};
  });
  const services = await import(`../src/services.js?test=${++moduleSequence}`);
  return {...services, calls};
}

test('walking service reverses coordinate order and accepts only a validated route', async t => {
  const {getWalkingRoute, calls} = await fixture(t, routePayload());
  assert.deepEqual(await getWalkingRoute(start, end), {
    points: [start, end], distance: 543.2, source: 'FOSSGIS 도보 경로', snapDistance: 4,
  });
  assert.match(calls[0].url, /126\.978000,37\.566500;126\.981000,37\.570000/);
  assert.match(calls[0].url, /routed-foot\/route\/v1\/foot\//);
  assert.equal(calls[0].options.credentials, 'omit');
});

test('invalid routing inputs are rejected before network transmission', async t => {
  const {getWalkingRoute, calls} = await fixture(t, routePayload());
  await assert.rejects(getWalkingRoute([91, 0], end), /출발지와 목적지/);
  await assert.rejects(getWalkingRoute(start, null), /출발지와 목적지/);
  assert.equal(calls.length, 0);
});

test('routing HTTP errors and network failures reject with no fabricated route', async t => {
  const {getWalkingRoute} = await fixture(t, null, {ok: false, status: 503});
  await assert.rejects(getWalkingRoute(start, end), /503/);
});

test('routing rejects a failed route response and invalid distances or coordinates', async t => {
  const {getWalkingRoute} = await fixture(t, null);
  for (const payload of [
    {code: 'NoRoute', routes: []},
    {...routePayload(), routes: []},
    {...routePayload(), routes: [{distance: 0, geometry: {coordinates: [[0, 0], [0, 1]]}}]},
    {...routePayload(), routes: [{distance: -1, geometry: {coordinates: [[0, 0], [0, 1]]}}]},
    {...routePayload(), routes: [{distance: 10, geometry: {coordinates: [[0, 91], [0, 1]]}}]},
    {...routePayload(), routes: [{distance: 10, geometry: {coordinates: [[0, 0]]}}]},
  ]) {
    t.mock.method(globalThis, 'fetch', async () => ({ok: true, json: async () => payload}));
    await assert.rejects(getWalkingRoute(start, end), /경로/);
  }
});

test('routing refuses waypoint snaps over 100 meters', async t => {
  const payload = routePayload(); payload.waypoints[1].distance = 100.01;
  const {getWalkingRoute} = await fixture(t, payload);
  await assert.rejects(getWalkingRoute(start, end), /100m/);
});

test('routing allows the exact 100-meter snap threshold', async t => {
  const payload = routePayload(); payload.waypoints[1].distance = 100;
  const {getWalkingRoute} = await fixture(t, payload);
  assert.equal((await getWalkingRoute(start, end)).snapDistance, 100);
});

test('malformed top-level route payload gives a clear route error instead of TypeError', async t => {
  const {getWalkingRoute} = await fixture(t, null);
  await assert.rejects(getWalkingRoute(start, end), error => !(error instanceof TypeError) && /경로/.test(error.message));
});

test('malformed geometry gives a clear route error instead of TypeError', async t => {
  const payload = routePayload(); payload.routes[0].geometry.coordinates = {};
  const {getWalkingRoute} = await fixture(t, payload);
  await assert.rejects(getWalkingRoute(start, end), error => !(error instanceof TypeError) && /경로/.test(error.message));
});

test('route geometry with non-coordinate entries is rejected cleanly', async t => {
  const payload = routePayload(); payload.routes[0].geometry.coordinates = [null, [126.981, 37.57]];
  const {getWalkingRoute} = await fixture(t, payload);
  await assert.rejects(getWalkingRoute(start, end), error => !(error instanceof TypeError) && /경로/.test(error.message));
});

test('nonfinite snap distances cannot bypass endpoint safety validation', async t => {
  const payload = routePayload(); payload.waypoints[0].distance = 'not-a-distance';
  const {getWalkingRoute} = await fixture(t, payload);
  await assert.rejects(getWalkingRoute(start, end), /경로/);
});

test('nearby stops query uses the selected origin and 700-meter radius', async t => {
  const {getNearbyStops, calls} = await fixture(t, {elements: [
    {id: 1, lat: start[0], lon: start[1], tags: {'name:ko': '시청', name: 'City Hall'}},
    {id: 2, lat: end[0], lon: end[1], tags: {name: 'Second stop'}},
    {id: 3, lat: 91, lon: 0},
  ]});
  assert.deepEqual(await getNearbyStops(start), [
    {id: 1, name: '시청', point: start}, {id: 2, name: 'Second stop', point: end},
  ]);
  assert.match(new URL(calls[0].url).searchParams.get('data'), /around:700,37\.566500,126\.978000/);
});

test('nearby stops accepts empty results and gives unnamed valid stops a fallback label', async t => {
  const {getNearbyStops} = await fixture(t, {elements: [{id: 1, lat: 0, lon: 0}]});
  assert.deepEqual(await getNearbyStops(start), [{id: 1, name: '이름 없는 정류장', point: [0, 0]}]);
  t.mock.method(globalThis, 'fetch', async () => ({ok: true, json: async () => ({elements: []})}));
  assert.deepEqual(await getNearbyStops(start), []);
});

test('nearby stops validates origin before making a request', async t => {
  const {getNearbyStops, calls} = await fixture(t, {elements: []});
  await assert.rejects(getNearbyStops([0, 181]), /출발지/);
  assert.equal(calls.length, 0);
});

test('nearby stops HTTP failures and invalid elements container are handled clearly', async t => {
  const {getNearbyStops} = await fixture(t, {}, {ok: false, status: 429});
  await assert.rejects(getNearbyStops(start), /429/);
  t.mock.method(globalThis, 'fetch', async () => ({ok: true, json: async () => ({elements: {}})}));
  await assert.rejects(getNearbyStops(start), /정류장/);
});

test('null nearby-stops payload gives a clear service error instead of TypeError', async t => {
  const {getNearbyStops} = await fixture(t, null);
  await assert.rejects(getNearbyStops(start), error => !(error instanceof TypeError) && /정류장/.test(error.message));
});

test('malformed stop entries cannot crash otherwise valid results', async t => {
  const {getNearbyStops} = await fixture(t, {elements: [null, {}, {id: 1, lat: start[0], lon: start[1]}]});
  const results = await getNearbyStops(start);
  assert.deepEqual(results, [{id: 1, name: '이름 없는 정류장', point: start}]);
});

test('search validates query lengths before sending any data', async t => {
  const {searchPlaces, calls} = await fixture(t, []);
  for (const query of ['', ' ', 'a', 'x'.repeat(181)]) await assert.rejects(searchPlaces(query), /2~180/);
  assert.equal(calls.length, 0);
});

test('search trims queries, parses valid coordinates, and caches successful searches', async t => {
  const {searchPlaces, calls} = await fixture(t, [
    {display_name: '서울 시청', lat: '37.5665', lon: '126.978'},
    {display_name: 'Out of bounds', lat: '91', lon: '0'},
  ]);
  const results = await searchPlaces('  서울 시청  ');
  assert.deepEqual(results, [{name: '서울 시청', point: start}]);
  assert.deepEqual(await searchPlaces('서울 시청'), results);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).searchParams.get('q'), '서울 시청');
});

test('search rate limits distinct uncached queries and allows another after the interval', async t => {
  const {searchPlaces, calls} = await fixture(t, []);
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  await searchPlaces('first');
  await assert.rejects(searchPlaces('second'), /잠시/);
  assert.equal(calls.length, 1);
  now += 1100;
  await searchPlaces('second');
  assert.equal(calls.length, 2);
});

test('search rejects HTTP errors and malformed top-level data', async t => {
  const {searchPlaces} = await fixture(t, {}, {ok: false, status: 500});
  await assert.rejects(searchPlaces('Seoul'), /500/);
  const second = await fixture(t, {});
  await assert.rejects(second.searchPlaces('Seoul'), /검색 결과/);
});

test('search does not coerce missing or blank coordinates into a real place at 0,0', async t => {
  const {searchPlaces} = await fixture(t, [
    {display_name: 'Missing values', lat: null, lon: null},
    {display_name: 'Blank values', lat: '', lon: '  '},
    {display_name: 'Boolean values', lat: false, lon: false},
    {display_name: 'Real zero coordinates', lat: '0', lon: '0'},
  ]);
  assert.deepEqual(await searchPlaces('destination'), [{name: 'Real zero coordinates', point: [0, 0]}]);
});

test('malformed search entries cannot crash otherwise valid results', async t => {
  const {searchPlaces} = await fixture(t, [null, {}, {display_name: 'Seoul', lat: '37.5665', lon: '126.978'}]);
  assert.deepEqual(await searchPlaces('Seoul'), [{name: 'Seoul', point: start}]);
});

test('fetch rejection is propagated without fabricating results', async t => {
  const failure = new Error('Network unavailable');
  const {getWalkingRoute} = await fixture(t, null, {implementation: async () => {throw failure;}});
  await assert.rejects(getWalkingRoute(start, end), error => error === failure);
});

test('malformed JSON rejects and does not produce a route', async t => {
  const {getWalkingRoute} = await fixture(t, null, {implementation: async () => ({
    ok: true, json: async () => {throw new SyntaxError('Invalid JSON');},
  })});
  await assert.rejects(getWalkingRoute(start, end), SyntaxError);
});

test('an already-aborted signal is forwarded as aborted to fetch', async t => {
  const controller = new AbortController(); controller.abort();
  const {getWalkingRoute} = await fixture(t, null, {implementation: async (url, options) => {
    assert.equal(options.signal.aborted, true);
    throw new DOMException('Aborted', 'AbortError');
  }});
  await assert.rejects(getWalkingRoute(start, end, controller.signal), {name: 'AbortError'});
});

test('aborting an in-flight caller signal cancels the request', async t => {
  const controller = new AbortController();
  const {getWalkingRoute} = await fixture(t, null, {implementation: async (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once: true});
  })});
  const request = getWalkingRoute(start, end, controller.signal);
  controller.abort();
  await assert.rejects(request, {name: 'AbortError'});
});

test('walking alternatives return only distinct validated provider routes',async t=>{
 const payload=routePayload();payload.routes.push({distance:650,geometry:{coordinates:[[126.978,37.5665],[126.979,37.569],[126.981,37.57]]}},payload.routes[0],{distance:2});
 const {getWalkingRoutes,calls}=await fixture(t,payload);const routes=await getWalkingRoutes(start,end);
 assert.equal(routes.length,2);assert.equal(routes[1].distance,650);
 assert.equal(new URL(calls[0].url).searchParams.get('alternatives'),'true');
 assert.match(calls[0].url,/routed-foot/);
});
test('one returned path stays one path instead of fabricating alternatives',async t=>{
 const {getWalkingRoutes}=await fixture(t,routePayload());assert.equal((await getWalkingRoutes(start,end)).length,1);
});
test('lamp comparison only counts genuine registered nodes near each candidate',async t=>{
 const {getRouteLamps,calls}=await fixture(t,{elements:[
 {id:1,lat:start[0],lon:start[1],tags:{highway:'street_lamp'}},
 {id:1,lat:start[0],lon:start[1],tags:{highway:'street_lamp'}},
 {id:2,lat:37.59,lon:127,tags:{highway:'street_lamp'}},
 {id:3,lat:start[0],lon:start[1],tags:{highway:'bus_stop'}},null]});
 const result=await getRouteLamps([{points:[start,end],distance:500}]);
 assert.equal(result[0].length,1);assert.equal(result[0][0].id,1);
 assert.match(new URL(calls[0].url).searchParams.get('data'),/highway=street_lamp/);
});
test('empty lighting data means zero registered nodes, not a dark-road classification',async t=>{
 const {getRouteLamps}=await fixture(t,{elements:[]});assert.deepEqual(await getRouteLamps([{points:[start,end],distance:500}]),[[]]);
});
test('lighting refuses large areas and partial overpass replies',async t=>{
 const {getRouteLamps,calls}=await fixture(t,{elements:[],remark:'runtime timeout'});
 await assert.rejects(getRouteLamps([{points:[[37,127],[38,128]],distance:100000}]),/5km/);assert.equal(calls.length,0);
 await assert.rejects(getRouteLamps([{points:[start,end],distance:500}]),/완전하게/);
});
