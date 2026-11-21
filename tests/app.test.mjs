import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setImmediate as flushAsync} from 'node:timers/promises';
import vm from 'node:vm';
import {nextManeuver} from '../src/navigation.js';
import * as core from '../src/core.js';
import {createMapAPI} from '../src/map-adapter.js';
import {SERVICES} from '../src/services.js';

// Run the actual application source with its external browser surfaces replaced.
// This tests event/state integration, not CSS layout, Leaflet rendering, or Safari APIs.
const appSource = (await readFile(new URL('../src/app.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '')
  + '\n;globalThis.appTest = {state, tracker, startTracking, stopTracking, setDestination, estimate, render, startDemo, exitDemo, askConsent};';

class FakeTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, callback) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), callback]);
  }
  async emit(type, details = {}) {
    await Promise.all((this.listeners.get(type) || []).map(callback => callback({preventDefault() {}, ...details})));
  }
}

class FakeElement extends FakeTarget {
  constructor(tagName = 'div') {
    super();
    this.tagName = tagName;
    this.textContent = ''; this.innerHTML = ''; this.value = ''; this.children = [];
    this.disabled = false; this.open = false;
    const classes = new Set();
    this.classList = {
      add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value),
      toggle(value, force) {
        const on = force ?? !classes.has(value);
        if (on) classes.add(value); else classes.delete(value);
        return on;
      },
    };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelector(selector) { return this.children.find(child => child.tagName === selector) || null; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function harness(options = {}) {
  let now = 1_700_000_000_000;
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  const document = Object.assign(new FakeTarget(), {
    visibilityState: 'visible', getElementById: element, createElement: tagName => new FakeElement(tagName), body: new FakeElement('body'),
  });
  document.body.classList.add('onboarding');
  const storage = options.storage || new Map();
  const localStorage = {
    getItem(key) { if (options.storageReadError) throw new Error('Storage blocked'); return storage.get(key) ?? null; },
    setItem(key,value) { if (options.storageWriteError) throw new Error('Quota exceeded'); storage.set(key,String(value)); },
    removeItem(key) { if (options.storageWriteError) throw new Error('Storage blocked'); storage.delete(key); },
  };
  const window = Object.assign(new FakeTarget(), {isSecureContext: options.secure ?? true, localStorage});
  if(options.storageAccessError) Object.defineProperty(window,'localStorage',{get(){throw new Error('SecurityError');}});
  const watches = [], cleared = [], intervals = [], busTargets = [], locations = [], centers = [], pans = [], timers = new Map();
  const navigator = {
    geolocation: {
      watchPosition(success, failure, settings) { watches.push({success, failure, settings}); return watches.length; },
      clearWatch(id) { cleared.push(id); },
      getCurrentPosition(success,failure,settings) { locations.push({success,failure,settings}); },
    },
  };
  if (options.wakeLock) navigator.wakeLock = options.wakeLock;
  if (options.noGeolocation) delete navigator.geolocation;
  const layer = () => ({
    addTo() { return this; }, remove() {}, clearLayers() {}, on() { return this; }, bindPopup() { return this; },
  });
  const mapEvents = new Map(); let sheetHooks = {};
  const map = {...layer(), on(type, callback) { mapEvents.set(type,callback); return this; }, setView(point) { centers.push(point); return this; }, fitBounds() { return this; },
    // options.pin: where the destination is inside the map element. A pan moves it, like a real map.
    latLngToContainerPoint() { return options.pin ? {x:options.pin.x - pans.reduce((sum,pan) => sum + pan[0],0),y:options.pin.y - pans.reduce((sum,pan) => sum + pan[1],0)} : null; }, panBy(offset) { pans.push(offset); return this; }};
  const L = {map: () => map, control: {zoom: () => layer()}, tileLayer: layer, layerGroup: layer,
    polyline: layer, marker: layer, divIcon: value => value, latLngBounds: value => value};
  class ClockDate extends Date { static now() { return now; } }
  const context = vm.createContext({
    ...core, nextManeuver, SERVICES, createMapAPI, KAKAO_JAVASCRIPT_KEY:'', SHARING_SERVER_ORIGIN: options.sharingServer || '', document, window, navigator, L, Date: ClockDate, Intl, AbortController, console,
    setInterval: callback => { intervals.push(callback); return intervals.length; },
    setTimeout: callback => { const id=Symbol();timers.set(id,callback);return id; }, clearTimeout:id=>timers.delete(id),
    getWalkingRoute: async () => {throw new Error('Unexpected network request');},
    getWalkingRoutes: options.getWalkingRoutes || (async () => {throw new Error('Unexpected network request');}),
    getRouteLamps: options.getRouteLamps || (async () => {throw new Error('Unexpected network request');}),
    searchPlaces: options.searchPlaces || (async () => {throw new Error('Unexpected network request');}),
    getNearbyStops: options.getNearbyStops || (async () => {throw new Error('Unexpected network request');}),
    initAccountUI: () => ({}), initLoginGate: () => {}, initBusPilot: () => ({render(){}}),
    createSheet: hooks => { let level = 0; sheetHooks = hooks; return {get level() { return level; },get height() { return (options.sheetHeights || [0,0,0])[level]; },peek:0,get dragging() { return Boolean(options.dragging?.()); },setLevel(next) { level = next; hooks.onLayout?.(); },layout() { hooks.onLayout?.(); },reveal() {}}; },
    initMeetupUI: () => ({refresh() {},pauseSharing() {},destinationChanged() {},useBusTime(timestamp) {busTargets.push(timestamp);}}),
  });
  vm.runInContext(appSource, context, {filename: 'src/app.js'});
  return {
    app: context.appTest, element, document, window, navigator, watches, cleared, busTargets, storage, locations, centers, pans,
    get pin() { return map.latLngToContainerPoint(); }, dragSheet() { sheetHooks.onDragStart?.(); },
    timeout() { for (const callback of [...timers.values()]) callback(); timers.clear(); },
    mapClick(lat,lng) { mapEvents.get('click')({latlng:{lat,lng}}); },
    get now() { return now; }, advance: milliseconds => { now += milliseconds; },
    tick() { for (const callback of intervals) callback(); },
    position({speed = 1.2, accuracy = 5, timestamp = now, latitude = 0, longitude = 0} = {}, watchIndex = watches.length - 1) {
      watches[watchIndex].success({timestamp, coords: {speed, accuracy, latitude, longitude}});
    },
  };
}

function addRoute(h) {
  const destination = [100 * 180 / (Math.PI * core.EARTH_RADIUS), 0];
  h.app.setDestination(destination, 'Test bus stop');
  h.app.state.route = {points: [[0, 0], destination], distance: 100, source: 'Test route'};
  h.app.render();
}

test('permission denial stops the watch and shows a recoverable explanation', () => {
  const h = harness();
  h.app.startTracking();
  assert.equal(h.app.state.tracking, true);
  assert.equal(h.watches[0].settings.enableHighAccuracy, true);
  h.watches[0].failure({code: 1});
  assert.equal(h.app.state.tracking, false);
  assert.equal(h.app.state.watchId, null);
  assert.deepEqual(h.cleared, [1]);
  assert.match(h.element('notice').textContent, /위치 권한이 허용되지/);
  assert.match(h.element('gps-button').innerHTML, /걷기 시작/);
});

test('insecure contexts and unsupported geolocation do not start a GPS watch', () => {
  for (const options of [{secure: false}, {noGeolocation: true}]) {
    const h = harness(options);
    h.app.startTracking();
    assert.equal(h.app.state.tracking, false);
    assert.equal(h.watches.length, 0);
    assert.notEqual(h.element('notice').textContent, '');
  }
});

test('GPS timeout keeps the watch active but does not invent an ETA', () => {
  const h = harness(); h.app.startTracking();
  h.watches[0].failure({code: 3});
  assert.equal(h.app.state.tracking, true);
  assert.equal(h.app.estimate(h.now).seconds, null);
  assert.match(h.element('notice').textContent, /시간이 초과/);
});

test('stale and future-dated GPS callbacks are discarded before moving the location', () => {
  const h = harness(); h.app.startTracking();
  h.position({timestamp: h.now - 15_001});
  assert.equal(h.app.state.position, null);
  assert.equal(h.app.state.lastGoodFix, 0);
  h.position({timestamp: h.now + 5001});
  assert.equal(h.app.state.position, null);
  assert.equal(h.app.tracker.current, null);
  assert.match(h.element('notice').textContent, /오래된 위치/);
});

test('GPS ETA becomes unknown after 15 seconds without a fresh accepted fix', () => {
  const h = harness(); h.app.startTracking(); h.position(); addRoute(h);
  assert.equal(h.app.estimate(h.now).seconds, 84);
  h.advance(15_001); h.tick();
  assert.equal(h.app.estimate(h.now).stale, true);
  assert.equal(h.app.estimate(h.now).seconds, null);
  assert.equal(h.element('walking-speed').textContent, '--');
  assert.equal(h.element('eta-minutes').textContent, '--');
  assert.match(h.element('eta-arrival').textContent, /GPS 신호/);
});

test('stationary GPS retains zero speed and suspends the displayed walking ETA', () => {
  const h = harness(); h.app.startTracking(); h.position({speed: 0}); addRoute(h);
  assert.equal(h.app.estimate(h.now).seconds, null);
  assert.equal(h.element('walking-speed').textContent, '0.0 km/h');
  assert.equal(h.element('eta-minutes').textContent, '--');
  assert.match(h.element('eta-arrival').textContent, /멈춰/);
});

test('invalid GPS fixes suspend ETA without replacing the last accepted point', () => {
  const h = harness(); h.app.startTracking(); h.position(); addRoute(h);
  h.advance(1000); h.position({latitude: 1, accuracy: 80});
  assert.equal(h.app.state.position[0], 0);
  assert.equal(h.app.estimate(h.now).seconds, null);
  assert.equal(h.app.estimate(h.now).unreliable, true);
});

test('backgrounding stops tracking, rejects late callbacks, and labels fallback ETA as configured pace', async () => {
  const h = harness(); h.app.startTracking(); h.position(); addRoute(h);
  h.document.visibilityState = 'hidden';
  await h.document.emit('visibilitychange');
  assert.equal(h.app.state.tracking, false);
  assert.deepEqual(h.cleared, [1]);
  assert.match(h.element('notice').textContent, /화면 잠금 또는 앱 전환/);
  assert.equal(h.element('speed-source').textContent, '기본 속도');
  assert.match(h.element('eta-arrival').textContent, /설정 속도 기준/);
  h.advance(1000); h.position({latitude: 1});
  assert.equal(h.app.state.position[0], 0);
  h.document.visibilityState = 'visible';
  await h.document.emit('visibilitychange');
  assert.equal(h.watches.length, 1, 'returning to the page must not silently restart GPS');
});

test('callbacks from a previous tracking session cannot change a new tracking session', () => {
  const h = harness(); h.app.startTracking(); h.position();
  h.app.stopTracking(); h.app.startTracking();
  h.position({latitude: 1}, 0);
  assert.equal(h.app.tracker.current, null);
  h.position({latitude: 0.001}, 1);
  assert.equal(h.app.state.position[0], 0.001);
});

test('wake-lock rejection does not crash GPS and tells the user to keep the screen awake', async () => {
  const h = harness({wakeLock: {request: async () => {throw new Error('Wake lock denied');}}});
  h.app.startTracking();
  await flushAsync();
  assert.equal(h.app.state.tracking, true);
  assert.equal(h.app.state.wakeLock, null);
  assert.match(h.element('gps-note').textContent, /자동 잠금을 막지 못했어요/);
});

test('a wake lock resolving after tracking stopped is immediately released', async () => {
  let resolveLock, releases = 0;
  const lock = {release: async () => {releases++;}, addEventListener() {}};
  const h = harness({wakeLock: {request: () => new Promise(resolve => {resolveLock = resolve;})}});
  h.app.startTracking(); h.app.stopTracking();
  resolveLock(lock);
  await flushAsync();
  assert.equal(releases, 1);
  assert.equal(h.app.state.wakeLock, null);
});

test('a late wake lock from an older GPS session is released even after a new session starts', async () => {
  const resolvers = [];
  let oldReleases = 0, newReleases = 0;
  const oldLock = {release: async () => {oldReleases++;}, addEventListener() {}};
  const newLock = {release: async () => {newReleases++;}, addEventListener() {}};
  const h = harness({wakeLock: {request: () => new Promise(resolve => resolvers.push(resolve))}});
  h.app.startTracking(); h.app.stopTracking(); h.app.startTracking();
  resolvers[1](newLock); await flushAsync();
  resolvers[0](oldLock); await flushAsync();
  assert.equal(oldReleases, 1, 'the lock for the stopped session should be released');
  assert.equal(h.app.state.wakeLock, newLock, 'the active session must keep its own lock');
  h.app.stopTracking(); await flushAsync();
  assert.equal(newReleases, 1);
});

test('manual bus input rejects invalid minutes and requires a destination', async () => {
  const h = harness();
  for (const value of ['', '0', '-1', '0.5', '181', 'NaN', 'Infinity']) {
    h.element('bus-minutes').value = value;
    await h.element('bus-form').emit('submit');
    assert.equal(h.app.state.busArrival, null);
    assert.match(h.element('notice').textContent, /1~180분/);
  }
  h.element('bus-minutes').value = '12';
  await h.element('bus-form').emit('submit');
  assert.equal(h.app.state.busArrival, null);
  assert.match(h.element('notice').textContent, /정류장을 목적지로/);
});

test('manual bus countdown uses the entered absolute time and is marked as non-live data', async () => {
  const h = harness(); h.app.startTracking(); h.position(); addRoute(h);
  h.element('bus-minutes').value = '12';
  await h.element('bus-form').emit('submit');
  const arrival = h.now + 720_000;
  assert.equal(h.app.state.busArrival, arrival);
  assert.deepEqual(h.busTargets, [arrival], 'the meeting plan receives the actual manual bus timestamp');
  assert.match(h.element('bus-result').children[0].textContent, /직접 입력 \/ 실시간 아님.*12분 후/);
  h.advance(60_000); h.tick();
  assert.equal(h.app.state.busArrival, arrival);
  assert.match(h.element('bus-result').children[0].textContent, /11분 후/);
  h.advance(660_000); h.tick();
  assert.match(h.element('bus-result').children[0].textContent, /입력한 도착 시간이 지났어요/);
});

test('changing destination or clearing the countdown removes a previous bus comparison', async () => {
  const h = harness(); addRoute(h);
  h.element('bus-minutes').value = '1'; await h.element('bus-form').emit('submit');
  assert.notEqual(h.app.state.busArrival, null);
  await h.element('bus-result').children[1].emit('click');
  assert.equal(h.app.state.busArrival, null);
  h.element('bus-minutes').value = '180'; await h.element('bus-form').emit('submit');
  assert.notEqual(h.app.state.busArrival, null);
  h.app.setDestination([1, 1], 'Different stop');
  assert.equal(h.app.state.busArrival, null);
});

test('onboarding never requests GPS until the user starts and a single fix cannot finish', async () => {
  const h=harness(); assert.equal(h.watches.length,0);
  await h.element('onboarding-start').emit('click');
  assert.match(h.element('onboarding-feedback').textContent,/권한/);
  h.position(); assert.equal(h.element('onboarding-finish').disabled,true);
});
test('onboarding calibrates from real moving samples then applies and keeps live GPS for the journey', async () => {
  const h=harness();await h.element('onboarding-start').emit('click');
  for(let i=0;i<7;i++){h.position({latitude:i*.000055,speed:1.2});if(i<6)h.advance(5000);}
  assert.equal(h.element('onboarding-finish').disabled,false);
  await h.element('onboarding-finish').emit('click');
  assert.equal(h.app.state.tracking,true);assert.equal(h.app.state.baseSpeed,1.2);
  assert.equal(h.element('onboarding-speed').textContent,'4.3');
  assert.match(h.element('notice').textContent,/측정 완료/);
  assert.equal(h.document.body.classList.contains('onboarding'),false);
  assert.equal(h.element('onboarding-card').classList.contains('hidden'),true);
});
test('onboarding denial and retry clear old samples; skip stops the watch', async () => {
  const h=harness();await h.element('onboarding-start').emit('click');h.watches[0].failure({code:1});
  assert.match(h.element('onboarding-feedback').textContent,/권한/);
  await h.element('onboarding-start').emit('click');assert.equal(h.watches.length,2);
  h.position();assert.equal(h.element('onboarding-finish').disabled,true);
  await h.element('onboarding-skip').emit('click');assert.equal(h.app.state.tracking,false);
  assert.equal(h.element('onboarding-card').classList.contains('hidden'),true);
});
test('poor accuracy can display approximate location but never becomes a route start or speed', async()=>{
  const h=harness();await h.element('onboarding-start').emit('click');h.position({accuracy:150});
  assert.equal(h.app.state.position,null);assert.equal(h.element('onboarding-speed').textContent,'—');
  assert.match(h.element('map-caption').textContent,/대략적인 위치/);assert.equal(h.element('onboarding-finish').disabled,true);
});
test('onboarding stale samples, stationary walking and app switching cannot finish', async()=>{
  const h=harness();await h.element('onboarding-start').emit('click');
  for(let i=0;i<8;i++){h.position({speed:0});h.advance(5000);}
  assert.equal(h.element('onboarding-finish').disabled,true);
  h.document.visibilityState='hidden';await h.document.emit('visibilitychange');
  assert.equal(h.app.state.tracking,false);assert.match(h.element('onboarding-feedback').textContent,/앱 전환/);
});
test('onboarding new samples after a long interruption must recalibrate',async()=>{
  const h=harness();await h.element('onboarding-start').emit('click');
  for(let i=0;i<7;i++){h.position({speed:1.2});h.advance(5000);}
  assert.equal(h.element('onboarding-finish').disabled,false);
  h.advance(31000);h.position({speed:1.2});assert.equal(h.element('onboarding-finish').disabled,true);
});
test('skip keeps default unmeasured label and never starts GPS or external map', async()=>{
 const h=harness();await h.element('onboarding-skip').emit('click');
 assert.equal(h.watches.length,0);assert.equal(h.app.state.mapEnabled,false);
 assert.match(h.element('journey-pace-note').textContent,/기본 속도.*실제 측정값이 아니에요/);
 assert.equal(h.element('onboarding-card').classList.contains('hidden'),true);
});
test('completed speed survives destination transition and manual adjustment changes provenance',async()=>{
 const h=harness();await h.element('onboarding-start').emit('click');
 for(let i=0;i<7;i++){h.position({latitude:i*.000055,speed:1.2});if(i<6)h.advance(5000);}
 await h.element('onboarding-finish').emit('click');await h.element('onboarding-skip').emit('click');
 assert.match(h.element('journey-pace-note').textContent,/내 측정 평균 4.3/);
 assert.equal(h.element('speed-source').textContent,'측정 평균');
 h.element('base-speed').value='5';await h.element('base-speed').emit('input');
 assert.match(h.element('journey-pace-note').textContent,/직접 설정 속도 5.0/);
});


test('manual start automatically hands the next map tap to destination', async () => {
  const h = harness();
  await h.element('set-start').emit('click');
  h.mapClick(37.5665,126.978);
  assert.deepEqual([...h.app.state.position],[37.5665,126.978]);
  assert.equal(h.app.state.pickingStart,false);
  h.mapClick(37.57,126.98);
  assert.deepEqual([...h.app.state.destination.point],[37.57,126.98]);
  assert.deepEqual([...h.app.state.position],[37.5665,126.978]);
  assert.equal(h.element('route-button').disabled,false);
});
test('explicit destination mode cancels an unfinished start selection', async () => {
  const h = harness();
  await h.element('set-start').emit('click');
  await h.element('set-destination').emit('click');
  h.mapClick(37.57,126.98);
  assert.equal(h.app.state.position,null);
  assert.deepEqual([...h.app.state.destination.point],[37.57,126.98]);
});
test('coordinate search resets start mode and subsequent map taps replace destination only', async () => {
  const h = harness();
  await h.element('set-start').emit('click');
  h.mapClick(37.5665,126.978);
  await h.element('set-start').emit('click');
  h.element('search-input').value='37.57,126.98';
  await h.element('search-form').emit('submit');
  assert.equal(h.app.state.pickingStart,false);
  h.mapClick(37.58,126.99);
  assert.deepEqual([...h.app.state.position],[37.5665,126.978]);
  assert.deepEqual([...h.app.state.destination.point],[37.58,126.99]);
});
test('clearing destination and returning from calibration reset map selection mode', async () => {
  const h = harness();
  h.app.setDestination([37.57,126.98],'test');
  await h.element('set-start').emit('click');
  await h.element('clear-destination').emit('click');
  assert.equal(h.app.state.pickingStart,false);
  await h.element('set-start').emit('click');
  await h.element('onboarding-skip').emit('click');
  assert.equal(h.app.state.pickingStart,false);
});


const PACE_KEY = 'walking-pace-profile-v1';
async function finishCalibration(h, speed=1.2) {
  await h.element('onboarding-start').emit('click');
  for(let i=0;i<7;i++){h.position({speed,latitude:i*.000055});if(i<6)h.advance(5000);}
  assert.equal(h.element('onboarding-finish').disabled,false);
  await h.element('onboarding-finish').emit('click');
}
test('calibrated speed is persisted without coordinates and restored without GPS or map consent', async()=>{
  const h=harness(); await finishCalibration(h);
  const profile=JSON.parse(h.storage.get(PACE_KEY));
  assert.deepEqual(Object.keys(profile).sort(),['measuredAt','origin','speed','version']);
  assert.equal(profile.version,1);assert.equal(profile.speed,1.2);assert.equal(profile.measuredAt,h.now);
  const restored=harness({storage:h.storage});
  assert.equal(restored.app.state.baseSpeed,1.2);
  assert.equal(restored.app.state.speedOrigin,'calibrated');
  assert.equal(restored.document.body.classList.contains('onboarding'),false);
  assert.equal(restored.element('onboarding-card').classList.contains('hidden'),true);
  assert.equal(restored.element('base-speed').value,'4.3');
  assert.equal(restored.watches.length,0);assert.equal(restored.app.state.mapEnabled,false);
  assert.equal(restored.app.state.position,null);assert.equal(restored.app.state.destination,null);
});
test('bad stored profiles never become measured speeds or bypass onboarding',()=>{
  for(const profile of ['not JSON','null','{}',JSON.stringify({version:2,speed:1.2,measuredAt:1}),
    ...[null,'1.2',0,-1,0.39,3.51,1e99].map(speed=>JSON.stringify({version:1,speed,measuredAt:1700000000000})),
    JSON.stringify({version:1,speed:1.2,measuredAt:'yesterday'})]) {
    const h=harness({storage:new Map([[PACE_KEY,profile]])});
    assert.equal(h.app.state.speedOrigin,'default');assert.equal(h.watches.length,0);
    assert.equal(h.document.body.classList.contains('onboarding'),true);
  }
});
test('blocked storage reads and access do not prevent app startup or calibration',async()=>{
  for(const options of [{storageReadError:true},{storageAccessError:true}]) {
    const h=harness(options);assert.equal(h.app.state.speedOrigin,'default');
    await finishCalibration(h);
    assert.equal(h.app.state.baseSpeed,1.2);
    assert.equal(h.document.body.classList.contains('onboarding'),false);
  }
});
test('failed persistence keeps measured session speed and visibly explains the limit',async()=>{
  const h=harness({storageWriteError:true}); await finishCalibration(h);
  assert.equal(h.app.state.baseSpeed,1.2);assert.equal(h.app.state.speedOrigin,'calibrated');
  assert.equal(h.document.body.classList.contains('onboarding'),false);
  assert.match(h.element('notice').textContent,/저장/);
  assert.equal(h.storage.has(PACE_KEY),false);
});
test('remeasuring resets displayed session and old samples but keeps last accepted speed until replacement',async()=>{
  const h=harness();await finishCalibration(h);
  const accepted=h.storage.get(PACE_KEY);
  await h.element('recalibrate-button').emit('click');
  assert.equal(h.document.body.classList.contains('onboarding'),true);
  assert.equal(h.element('onboarding-card').classList.contains('hidden'),false);
  assert.equal(h.element('onboarding-time').textContent,'00:00');
  assert.equal(h.element('onboarding-speed').textContent,'—');
  assert.equal(h.element('onboarding-finish').disabled,true);
  assert.equal(h.element('onboarding-start').classList.contains('hidden'),false);
  assert.equal(h.storage.get(PACE_KEY),accepted);
  await h.element('onboarding-start').emit('click');h.position({speed:1.6});
  assert.equal(h.element('onboarding-finish').disabled,true);
  await h.element('onboarding-skip').emit('click');
  assert.equal(h.app.state.baseSpeed,1.2);assert.equal(h.storage.get(PACE_KEY),accepted);
  await h.element('recalibrate-button').emit('click');await finishCalibration(h,1.6);
  assert.ok(Math.abs(h.app.state.baseSpeed-1.6)<1e-9);assert.ok(Math.abs(JSON.parse(h.storage.get(PACE_KEY)).speed-1.6)<1e-9);
  const stable=h.storage.get(PACE_KEY);await h.element('onboarding-finish').emit('click');
  assert.equal(h.storage.get(PACE_KEY),stable);
});

test('stopped incomplete measurement hides unusable finish and retry resets samples', async()=>{
 const h=harness(); await h.element('onboarding-start').emit('click');h.position({accuracy:28});
 await h.element('onboarding-stop').emit('click');
 assert.equal(h.element('onboarding-finish').classList.contains('hidden'),true);
 assert.equal(h.element('onboarding-start').classList.contains('hidden'),false);
 assert.match(h.element('onboarding-feedback').textContent,/표본이 부족/);
 await h.element('onboarding-start').emit('click');
 assert.equal(h.element('onboarding-start').classList.contains('hidden'),true);
 assert.equal(h.element('onboarding-finish').disabled,true);
 await h.element('onboarding-stop').emit('click');await h.element('onboarding-skip').emit('click');
 assert.equal(h.element('onboarding-card').classList.contains('hidden'),true);
});
test('valid stopped measurement remains applicable and persists across revisit',async()=>{
 const h=harness();await h.element('onboarding-start').emit('click');
 for(let i=0;i<7;i++){h.position({speed:1.2});if(i<6)h.advance(5000);}
 await h.element('onboarding-stop').emit('click');h.advance(60000);h.tick();
 assert.equal(h.element('onboarding-finish').disabled,false);
 assert.equal(h.element('onboarding-start').classList.contains('ob-secondary'),true);
 assert.equal(h.element('onboarding-speed').textContent,'4.3');
 await h.element('onboarding-finish').emit('click');
 assert.equal(h.element('onboarding-card').classList.contains('hidden'),true);
 assert.equal(harness({storage:h.storage}).app.state.baseSpeed,1.2);
});
test('stale samples cannot be rescued by pressing stop',async()=>{
 const h=harness();await h.element('onboarding-start').emit('click');
 for(let i=0;i<7;i++){h.position({speed:1.2});if(i<6)h.advance(5000);}
 h.advance(16000);await h.element('onboarding-stop').emit('click');
 assert.equal(h.element('onboarding-finish').disabled,true);
});

test('map remains explicit opt-in with a visible explanation during GPS calibration',async()=>{
  const h=harness(); await h.element('onboarding-start').emit('click');h.position();
  assert.equal(h.app.state.mapEnabled,false);
  assert.equal(h.element('onboarding-map-view').classList.contains('hidden'),true);
  assert.match(h.element('onboarding-map-status').textContent,/아래 버튼/);
  await h.element('onboarding-map').emit('click');
  assert.equal(h.app.state.mapEnabled,true);
  assert.equal(h.element('onboarding-map-view').classList.contains('hidden'),false);
});
test('destination selection asks routing consent and cancel keeps coordinates private',async()=>{
  const h=harness();await h.element('onboarding-skip').emit('click');
  h.app.state.position=[37.56,126.97];h.app.setDestination([37.57,126.98],'Destination');
  assert.equal(h.element('consent-dialog').open,true);
  assert.match(h.element('tracking-tag').innerHTML,/경로 필요/);
  await h.element('consent-cancel').emit('click');await flushAsync();
  assert.equal(h.app.state.route,null);assert.equal(h.app.state.routeBusy,false);
  assert.equal(h.element('eta-minutes').textContent,'--');
});
test('new destination closes outdated consent; route errors do not look like speed measuring',async()=>{
  const h=harness();await h.element('onboarding-skip').emit('click');
  h.app.state.position=[37.56,126.97];h.app.setDestination([37.57,126.98],'Old');
  h.app.setDestination([37.58,126.99],'New');
  await h.element('consent-allow').emit('click');await flushAsync();
  assert.equal(h.app.state.destination.name,'New');
  assert.equal(h.app.state.routeBusy,false);
  assert.match(h.element('notice').textContent,/불러오지 못/);
  assert.match(h.element('tracking-tag').innerHTML,/경로 필요/);
});


test('real stop results open a clearly unconnected information panel before route selection',async()=>{
  const h=harness({getNearbyStops:async()=>[{id:123,name:'Test stop',point:[37.57,126.98]}]});
  await h.element('onboarding-skip').emit('click');h.app.state.position=[37.56,126.97];
  const request=h.element('map-stops').emit('click');
  assert.equal(h.element('consent-dialog').open,true);await h.element('consent-allow').emit('click');await request;
  assert.equal(h.element('stop-results').children.length,1);
  await h.element('stop-results').children[0].emit('click');
  assert.equal(h.element('stop-dialog').open,true);assert.equal(h.app.state.destination,null);
  assert.equal(h.element('stop-name').textContent,'Test stop');
  await h.element('stop-close').emit('click');assert.equal(h.element('stop-dialog').open,false);
  await h.element('stop-results').children[0].emit('click');await h.element('stop-walk').emit('click');
  assert.equal(h.element('stop-dialog').open,false);assert.equal(h.app.state.destination.name,'Test stop');
  assert.equal(h.element('consent-dialog').open,true);await h.element('consent-cancel').emit('click');
});

test('stop lookup timeout explains retry and restores the map lookup button',async()=>{
 const h=harness({getNearbyStops:async()=>{const e=new Error('aborted');e.name='AbortError';throw e;}});
 h.app.state.position=[37.56,126.97];
 const request=h.element('map-stops').emit('click');await h.element('consent-allow').emit('click');await request;
 assert.match(h.element('notice').textContent,/시간이 초과/);
 assert.equal(h.element('map-stops').disabled,false);assert.equal(h.app.state.stopBusy,false);
});


test('real route candidates sort by personal-pace duration and selection changes ETA route',async()=>{
 const a=[37.56,126.97],b=[37.561,126.97];
 const h=harness({getWalkingRoutes:async()=>[
 {points:[a,[37.5605,126.9704],b],distance:180,snapDistance:0},
 {points:[a,b],distance:120,snapDistance:0}]});
 await h.element('onboarding-skip').emit('click');h.app.state.position=a;h.app.setDestination(b,'Destination');
 await h.element('consent-allow').emit('click');await flushAsync();
 assert.equal(h.app.state.routes.length,2);assert.equal(h.app.state.route.distance,120);
 assert.equal(h.element('route-options').children.length,2);assert.match(h.element('route-options').children[0].children[0].textContent,/빠른 도보 후보/);
 await h.element('route-options').children[1].emit('click');assert.equal(h.app.state.route.distance,180);
 await h.element('clear-destination').emit('click');assert.equal(h.app.state.routes.length,0);
});
test('lamp queries require consent and never call an empty result a dark road',async()=>{
 const a=[37.56,126.97],b=[37.561,126.97];let calls=0;
 const h=harness({getWalkingRoutes:async()=>[{points:[a,b],distance:120,snapDistance:0}],getRouteLamps:async()=>{calls++;return [[]];}});
 await h.element('onboarding-skip').emit('click');h.app.state.position=a;h.app.setDestination(b,'Destination');
 await h.element('consent-allow').emit('click');await flushAsync();
 let q=h.element('lamp-button').emit('click');assert.equal(calls,0);await h.element('consent-cancel').emit('click');await q;
 assert.equal(calls,0);q=h.element('lamp-button').emit('click');await h.element('consent-allow').emit('click');await q;
 assert.equal(calls,1);assert.match(h.element('lamp-status').textContent,/어두운 길이라는 뜻은 아니/);
 assert.match(h.element('route-options').children[0].children[2].textContent,/0개 \/ 실제 밝기 아님/);
});
test('new destination invalidates in-flight lighting results',async()=>{
 const a=[37.56,126.97],b=[37.561,126.97];let resolve;
 const h=harness({getWalkingRoutes:async()=>[{points:[a,b],distance:120,snapDistance:0}],getRouteLamps:()=>new Promise(r=>resolve=r)});
 await h.element('onboarding-skip').emit('click');h.app.state.position=a;h.app.setDestination(b,'Destination');await h.element('consent-allow').emit('click');await flushAsync();
 const q=h.element('lamp-button').emit('click');await h.element('consent-allow').emit('click');await flushAsync();
 h.app.setDestination([37.562,126.98],'New');resolve([[{id:1,point:a}]]);await q;
 assert.equal(h.app.state.lampResults,null);assert.equal(h.app.state.lampBusy,false);await h.element('consent-cancel').emit('click');
});

test('navigation requires live GPS and suppresses stale directions',()=>{
 const h=harness(); addRoute(h); h.app.state.route.steps=[{at:70,type:'turn',modifier:'left',name:'길'}];
 h.app.render(); assert.match(h.element('navigation-direction').textContent,/걷기를 시작/);
 h.app.startTracking();h.position();h.app.render();assert.match(h.element('navigation-direction').textContent,/왼쪽/);
 h.advance(16000);h.app.render();assert.match(h.element('navigation-direction').textContent,/GPS 갱신 대기/);
});

test('location map starts GPS and remains visible when calibration starts or restarts', async()=>{
 const h=harness();await h.element('onboarding-map').emit('click');h.position();
 assert.equal(h.app.state.mapEnabled,true);assert.equal(h.watches.length,1);
 assert.match(h.element('onboarding-status').textContent,/위치 확인 완료/);
 await h.element('onboarding-start').emit('click');
 assert.equal(h.element('onboarding-map-view').classList.contains('hidden'),false);
 await h.element('onboarding-stop').emit('click');await h.element('onboarding-start').emit('click');
 assert.equal(h.element('onboarding-map-view').classList.contains('hidden'),false);
});

test('manual pace survives reload and stays labeled as manual',async()=>{
 const h=harness();h.element('manual-pace').value='3.5';await h.element('manual-pace-form').emit('submit');
 const restored=harness({storage:h.storage});
 assert.equal(restored.app.state.speedOrigin,'manual');assert.equal(restored.app.state.baseSpeed,3.5/3.6);
 assert.equal(restored.watches.length,0);assert.equal(restored.app.state.position,null);
 restored.element('base-speed').value='4.7';await restored.element('base-speed').emit('input');
 assert.equal(harness({storage:h.storage}).app.state.baseSpeed,4.7/3.6);
});

test('silent GPS loss ends waiting, suppresses fallback ETA and offers recovery',async()=>{
 const h=harness();await finishCalibration(h);addRoute(h);
 h.advance(26000);h.tick();
 assert.equal(h.app.state.tracking,false);assert.equal(h.app.estimate(h.now).seconds,null);
 assert.equal(h.element('gps-recovery').classList.contains('hidden'),false);
 assert.match(h.element('gps-problem').textContent,/25초/);
 await h.element('gps-use-saved').emit('click');assert.notEqual(h.app.estimate(h.now).seconds,null);
 await h.element('gps-retry').emit('click');h.position();assert.equal(h.app.state.gpsIssue,'');
});

test('persistent poor GPS and insufficient moving samples terminate calibration with next actions',async()=>{
 const h=harness();await h.element('onboarding-start').emit('click');h.position({accuracy:200});h.advance(26000);h.tick();
 assert.equal(h.app.state.tracking,false);assert.equal(h.element('onboarding-recovery').classList.contains('hidden'),false);
 await h.element('onboarding-retry').emit('click');
 for(let i=0;i<25;i++){h.position({speed:0});h.advance(5000);h.tick();}
 assert.equal(h.app.state.tracking,false);assert.match(h.element('onboarding-problem').textContent,/보행 표본/);
 assert.equal(h.element('onboarding-finish').disabled,true);
});

test('chosen pace flows to a routed destination and recent GPS speed changes ETA',async()=>{
 const end=[.01,0], h=harness({getWalkingRoutes:async start=>[{points:[start,end],distance:1100,snapDistance:0}]});
 await finishCalibration(h);h.app.setDestination(end,'Destination');await h.element('consent-allow').emit('click');await flushAsync();
 const first=h.app.estimate(h.now).seconds;
 for(let i=1;i<=6;i++){h.advance(5000);h.position({latitude:.00033+i*.00003,speed:.6});}
 const slower=h.app.estimate(h.now).seconds;assert.ok(slower>first);
 for(let i=1;i<=6;i++){h.advance(5000);h.position({latitude:.00051+i*.00008,speed:1.8});}
 assert.ok(h.app.estimate(h.now).seconds<slower);assert.match(h.element('map-tip').textContent,/도보 약/);
});

test('unverified endpoint gaps are never added as walking distance or ETA',async()=>{
 const a=[37.56,126.97],b=[37.561,126.97];
 const h=harness({getWalkingRoutes:async()=>[{points:[a,b],distance:120,snapDistance:35}]});
 await h.element('onboarding-skip').emit('click');h.app.state.position=a;h.app.setDestination([37.562,126.97],'Unconnected entrance');
 await h.element('consent-allow').emit('click');await flushAsync();
 assert.equal(h.app.state.route.distance,120);assert.equal(h.app.state.route.points.length,2);
 assert.equal(h.app.estimate(h.now).seconds,null);assert.equal(h.element('eta-minutes').textContent,'--');
 assert.match(h.element('route-options').children[0].children[0].textContent,/끝점 확인 필요/);
});

test('Korean composition never submits a partial query and final Korean text is preserved',async()=>{
 const h=harness();h.element('search-input').value='대구대 정문1';
 await h.element('search-input').emit('compositionstart');await h.element('search-form').emit('submit');
 assert.equal(h.element('consent-dialog').open,false);
 await h.element('search-input').emit('compositionend');const pending=h.element('search-form').emit('submit');
 assert.match(h.element('consent-copy').textContent,/대구대 정문1/);
 await h.element('consent-cancel').emit('click');await pending;
});

test('current-location button centers fresh GPS without resetting live speed or destination',async()=>{
 const h=harness();await h.element('enable-map').emit('click');h.app.startTracking();h.position({latitude:37.56,longitude:126.97});
 h.app.setDestination([37.57,126.98],'Destination');const speed=h.app.tracker.current;
 await h.element('locate-me').emit('click');
 assert.equal(h.locations.length,0);assert.deepEqual([...h.centers.at(-1)],[37.56,126.97]);
 assert.equal(h.app.tracker.current,speed);assert.equal(h.app.state.tracking,true);assert.equal(h.app.state.destination.name,'Destination');
});

test('one-shot current location rejects poor fixes, times out, and does not pretend a manual start is GPS',async()=>{
 const h=harness();await h.element('enable-map').emit('click');h.app.state.position=[1,1];
 await h.element('locate-me').emit('click');assert.equal(h.locations.length,1);
 h.locations[0].success({timestamp:h.now,coords:{latitude:37.56,longitude:126.97,accuracy:150}});
 assert.deepEqual([...h.app.state.position],[1,1]);assert.match(h.element('map-location-status').textContent,/정확한/);
 await h.element('locate-me').emit('click');h.timeout();
 assert.equal(h.element('locate-me').disabled,false);assert.match(h.element('map-location-status').textContent,/초과/);
 h.locations[1].success({timestamp:h.now,coords:{latitude:37.56,longitude:126.97,accuracy:5}});
 assert.deepEqual([...h.app.state.position],[1,1]);
 await h.element('locate-me').emit('click');h.locations[2].success({timestamp:h.now,coords:{latitude:37.56,longitude:126.97,accuracy:5}});
 assert.deepEqual([...h.app.state.position],[37.56,126.97]);assert.equal(h.app.state.tracking,false);
});

test('a consent requested while another is open waits its turn instead of being silently refused',async()=>{
  const h=harness();await h.element('onboarding-skip').emit('click');
  h.app.state.position=[37.56,126.97];h.app.setDestination([37.57,126.98],'Destination');
  // The routing consent is open. A second feature (for example location sharing) asks now.
  assert.match(h.element('consent-title').textContent,/도보 경로/);
  let answer='pending';h.app.askConsent('내 위치를 이 약속방에 공유','share text','share note').then(value=>{answer=value;});
  await flushAsync();
  assert.equal(answer,'pending');assert.match(h.element('consent-title').textContent,/도보 경로/);
  await h.element('consent-cancel').emit('click');await flushAsync();
  // The first answer does not leak into the second question, which is now shown.
  assert.equal(answer,'pending');assert.equal(h.element('consent-dialog').open,true);
  assert.equal(h.element('consent-title').textContent,'내 위치를 이 약속방에 공유');
  assert.equal(h.element('consent-copy').textContent,'share text');assert.equal(h.element('consent-footnote').textContent,'share note');
  await h.element('consent-allow').emit('click');await flushAsync();
  assert.equal(answer,true);assert.equal(h.element('consent-dialog').open,false);
});
test('changing the destination refuses every waiting consent and leaves only the new one open',async()=>{
  const h=harness();await h.element('onboarding-skip').emit('click');
  h.app.state.position=[37.56,126.97];h.app.setDestination([37.57,126.98],'First');
  const answers=[];h.app.askConsent('queued','text').then(value=>answers.push(value));
  h.app.setDestination([37.58,126.99],'Second');await flushAsync();
  assert.deepEqual(answers,[false]);assert.equal(h.app.state.route,null);
  assert.equal(h.element('consent-dialog').open,true);assert.match(h.element('consent-title').textContent,/도보 경로/);
  await h.element('consent-cancel').emit('click');await flushAsync();
  assert.equal(h.element('consent-dialog').open,false);
});

test('routing consent is asked once per visit, then a new destination gets its walking time immediately',async()=>{
  let calls=0;const h=harness({getWalkingRoutes:async(start,end)=>{calls++;return [{points:[start,end],distance:300,snapDistance:0}];}});
  await h.element('onboarding-skip').emit('click');
  h.app.state.position=[37.56,126.97];h.app.setDestination([37.561,126.97],'First');
  assert.equal(h.element('consent-dialog').open,true);assert.equal(calls,0);
  await h.element('consent-allow').emit('click');await flushAsync();
  assert.equal(calls,1);assert.notEqual(h.app.state.route,null);assert.notEqual(h.element('eta-minutes').textContent,'--');
  h.app.setDestination([37.562,126.97],'Second');await flushAsync();
  assert.equal(h.element('consent-dialog').open,false);assert.equal(calls,2);
  assert.notEqual(h.app.state.route,null);assert.notEqual(h.element('eta-minutes').textContent,'--');
});
test('declining the routing consent does not count as agreement for the next destination',async()=>{
  let calls=0;const h=harness({getWalkingRoutes:async(start,end)=>{calls++;return [{points:[start,end],distance:300,snapDistance:0}];}});
  await h.element('onboarding-skip').emit('click');
  h.app.state.position=[37.56,126.97];h.app.setDestination([37.561,126.97],'First');
  await h.element('consent-cancel').emit('click');await flushAsync();
  h.app.setDestination([37.562,126.97],'Second');await flushAsync();
  assert.equal(h.element('consent-dialog').open,true);assert.equal(calls,0);
});
test('a destination chosen before the location is known starts GPS and routes once on the first accurate fix',async()=>{
  let calls=0;const h=harness({getWalkingRoutes:async(start,end)=>{calls++;return [];}});
  await h.element('onboarding-skip').emit('click');h.app.state.routeConsent=true;
  h.app.setDestination([0.001,0],'Destination');
  assert.equal(h.app.state.tracking,true);assert.equal(h.watches.length,1);assert.equal(calls,0);
  h.position({latitude:0,longitude:0});await flushAsync();
  assert.equal(calls,1);
  // No route came back. Walking on must not send the position to the routing server again.
  h.advance(2000);h.position({latitude:0.00002,longitude:0});await flushAsync();
  h.advance(2000);h.position({latitude:0.00004,longitude:0});await flushAsync();
  assert.equal(calls,1);
});
test('clearing the destination cancels the pending automatic route',async()=>{
  let calls=0;const h=harness({getWalkingRoutes:async()=>{calls++;return [];}});
  await h.element('onboarding-skip').emit('click');h.app.state.routeConsent=true;
  h.app.setDestination([0.001,0],'Destination');await h.element('clear-destination').emit('click');
  h.position({latitude:0,longitude:0});await flushAsync();
  assert.equal(calls,0);
});
test('a tab opens its sheet and tapping it again or the map closes it',async()=>{
  const h=harness();await h.element('onboarding-skip').emit('click');const body=h.document.body;
  await h.element('view-bus').emit('click');assert.equal(body.classList.contains('sheet-open'),true);
  await h.element('view-bus').emit('click');assert.equal(body.classList.contains('sheet-open'),false);
  await h.element('view-meet').emit('click');assert.equal(body.classList.contains('sheet-open'),true);
  await h.element('sheet-scrim').emit('click');assert.equal(body.classList.contains('sheet-open'),false);
  // Choosing a destination (for example from the search box) does not close an open sheet.
  await h.element('view-main').emit('click');h.app.state.position=[37.56,126.97];h.app.setDestination([37.57,126.98],'Destination');
  assert.equal(body.classList.contains('sheet-open'),true);assert.equal(body.classList.contains('has-destination'),true);
  // The collapsed walking-time strip reopens the route view.
  await h.element('sheet-scrim').emit('click');await h.element('view-bus').emit('click');await h.element('view-bus').emit('click');
  await h.element('sheet-board').emit('click');assert.equal(body.classList.contains('sheet-open'),true);
});
test('a configured sharing server is filled in and its address field is hidden from friends',async()=>{
  const configured=harness({sharingServer:'https://share.example.test'});
  assert.equal(configured.element('sharing-server').value,'https://share.example.test');
  assert.equal(configured.element('sharing-server-settings').classList.contains('hidden'),true);
  const empty=harness();
  assert.equal(empty.element('sharing-server').value,'');assert.equal(empty.element('sharing-server-settings').classList.contains('hidden'),false);
});

test('search results list the place name and its address on separate lines',async()=>{
  const h=harness({searchPlaces:async()=>[{name:'대구대학교',address:'경북 경산시 진량읍',point:[35.9,128.85],source:'테스트'},{name:'주소 없는 곳',point:[35.8,128.8]}]});
  h.element('search-input').value='대구대';
  const pending=h.element('search-form').emit('submit');await flushAsync();
  await h.element('consent-allow').emit('click');await pending;
  const rows=h.element('search-results').children;
  assert.equal(h.element('search-results').classList.contains('hidden'),false);
  assert.equal(rows.length,2);
  assert.deepEqual(rows[0].children[0].children.map(child=>[child.tagName,child.textContent]),[['strong','대구대학교'],['small','경북 경산시 진량읍']]);
  assert.deepEqual(rows[1].children[0].children.map(child=>[child.tagName,child.textContent]),[['strong','주소 없는 곳']]);
  await rows[0].children[0].emit('click');
  assert.equal(h.app.state.destination.name,'대구대학교');
  assert.equal(h.element('search-results').classList.contains('hidden'),true);
});

test('the clear button shows only with text, then empties the box, closes the results and refocuses',async()=>{
  const h=harness({searchPlaces:async()=>[{name:'대구대학교',point:[35.9,128.85]}]});
  const input=h.element('search-input'),clear=h.element('search-clear');
  let focused=0;input.focus=()=>{focused++;};
  assert.equal(clear.classList.contains('hidden'),true);
  input.value='대구대';await input.emit('input');
  assert.equal(clear.classList.contains('hidden'),false);
  const pending=h.element('search-form').emit('submit');await flushAsync();
  await h.element('consent-allow').emit('click');await pending;
  assert.equal(h.element('search-results').classList.contains('hidden'),false);
  await clear.emit('click');
  assert.equal(input.value,'');assert.equal(focused,1);
  assert.equal(clear.classList.contains('hidden'),true);
  assert.equal(h.element('search-results').classList.contains('hidden'),true);
  input.value='';await input.emit('input');
  assert.equal(clear.classList.contains('hidden'),true);
});

test('clearing the box while a search is on its way never opens that search afterwards',async()=>{
  let finish,signal;
  const h=harness({searchPlaces:(query,abort)=>{signal=abort;return new Promise(resolve=>{finish=resolve;});}});
  h.element('search-input').value='대구대';await h.element('search-input').emit('input');
  const pending=h.element('search-form').emit('submit');await flushAsync();
  await h.element('consent-allow').emit('click');await flushAsync();
  assert.equal(h.element('search-button').disabled,true);
  await h.element('search-clear').emit('click');
  assert.equal(signal.aborted,true);
  assert.equal(h.element('search-button').disabled,false);
  assert.equal(h.element('notice').textContent,'');
  finish([{name:'대구대학교',point:[35.9,128.85]}]);await pending;
  assert.equal(h.element('search-results').classList.contains('hidden'),true);
  assert.equal(h.element('search-results').children.length,0);
});

test('the summary line hides the distance placeholder until a route gives a distance',async()=>{
  const h=harness({getWalkingRoutes:async()=>[{points:[[0,0],[0,0.002]],distance:222,snapDistance:0}]});
  await h.element('onboarding-skip').emit('click');
  assert.equal(h.element('remaining-distance').classList.contains('empty'),true);
  assert.equal(h.document.body.classList.contains('has-destination'),false);
  h.app.state.position=[0,0];h.app.state.routeConsent=true;h.app.setDestination([0,0.002],'Destination');
  await flushAsync();await flushAsync();h.app.render();
  assert.equal(h.document.body.classList.contains('has-destination'),true);
  assert.equal(h.element('remaining-distance').classList.contains('empty'),false);
  assert.match(h.element('remaining-distance').textContent,/m$/);
});

test('a result that is one long comma-separated label is split for display only',async()=>{
  const label='서울역, 지하2, 세종대로, 봉래동2가, 중구, 서울특별시';
  const h=harness({searchPlaces:async()=>[{name:label,point:[37.555,126.972]},{name:'대구대학교, 진량읍',address:'경북 경산시',point:[35.9,128.85]}]});
  await h.element('onboarding-skip').emit('click');
  h.element('search-input').value='서울역';
  const pending=h.element('search-form').emit('submit');await flushAsync();
  await h.element('consent-allow').emit('click');await pending;
  const rows=h.element('search-results').children;
  assert.deepEqual(rows[0].children[0].children.map(child=>[child.tagName,child.textContent]),[['strong','서울역'],['small','지하2, 세종대로, 봉래동2가, 중구, 서울특별시']]);
  // A separate address is used as it is; the name is not split then.
  assert.deepEqual(rows[1].children[0].children.map(child=>[child.tagName,child.textContent]),[['strong','대구대학교, 진량읍'],['small','경북 경산시']]);
  await rows[0].children[0].emit('click');
  assert.equal(h.app.state.destination.name,label);
  assert.equal(h.element('destination-name').textContent,label);
});

test('choosing a destination raises a collapsed sheet to half, and leaves an open one where it is',async()=>{
  const h=harness();const body=h.document.body;
  await h.element('onboarding-skip').emit('click');
  assert.equal(body.classList.contains('sheet-open'),false);
  h.mapClick(37.57,126.98);
  assert.equal(body.classList.contains('sheet-open'),true);assert.equal(body.classList.contains('sheet-full'),false);
  // Already at half: stays at half.
  h.app.setDestination([37.571,126.98],'Second');
  assert.equal(body.classList.contains('sheet-open'),true);assert.equal(body.classList.contains('sheet-full'),false);
  // Collapsed again by the user, then a stop is chosen: half again.
  await h.element('sheet-scrim').emit('click');
  assert.equal(body.classList.contains('sheet-open'),false);
  h.app.setDestination([37.572,126.98],'Stop','OSM 버스 정류장');
  assert.equal(body.classList.contains('sheet-open'),true);
});

test('a destination set during the pace measurement does not open the hidden sheet',()=>{
  const h=harness();
  h.app.setDestination([37.57,126.98],'Destination');
  assert.equal(h.document.body.classList.contains('sheet-open'),false);
});

test('without a route the summary points to the route button without saying where it is',async()=>{
  const h=harness();await h.element('onboarding-skip').emit('click');
  h.app.state.position=[37.56,126.97];h.app.setDestination([37.57,126.98],'Destination');
  await h.element('consent-cancel').emit('click');await flushAsync();h.app.render();
  assert.equal(h.element('eta-arrival').textContent,'경로 계산 버튼을 눌러 주세요');
});

// 375x812 phone: the sheet's box starts at y=108 (under the chips) and is 648px tall.
async function mapScreen(options) {
  const h=harness({sheetHeights:[149,446,648],...options});
  await h.element('onboarding-skip').emit('click');await h.element('enable-map').emit('click');
  Object.assign(h.element('sheet'),{offsetTop:108,offsetHeight:648});h.element('map').offsetWidth=375;
  return h;
}
test('a new pin under the raised sheet is panned into view without changing the zoom',async()=>{
  // At half the sheet's top is at 108 + 648 - 446 = 310. A tap at y=350 ends up under it.
  const h=await mapScreen({pin:{x:180,y:350}});
  const centred=h.centers.length;
  h.mapClick(37.57,126.98);
  assert.equal(h.document.body.classList.contains('sheet-open'),true);
  assert.deepEqual(h.pans.map(pan=>[...pan]),[[0,80]]);assert.equal(h.centers.length,centred);
});
test('a pin that is already visible, or a map that is off, is left alone',async()=>{
  const visible=await mapScreen({pin:{x:180,y:200}});
  visible.mapClick(37.57,126.98);assert.deepEqual(visible.pans,[]);
  const off=harness({sheetHeights:[149,446,648],pin:{x:180,y:350}});
  await off.element('onboarding-skip').emit('click');Object.assign(off.element('sheet'),{offsetTop:108,offsetHeight:648});off.element('map').offsetWidth=375;
  off.mapClick(37.57,126.98);assert.deepEqual(off.pans,[]);
});
test('a pin under the search box and chips, or at the side edge, is panned in too',async()=>{
  const h=await mapScreen({pin:{x:370,y:90}});
  h.app.setDestination([37.57,126.98],'Destination');
  assert.deepEqual(h.pans.map(pan=>[...pan]),[[35,-58]]);
});
test('a message that appears raises a collapsed sheet once; one that only updates does not',async()=>{
  const h=harness();const open=()=>h.document.body.classList.contains('sheet-open');
  await h.element('onboarding-skip').emit('click');
  await h.element('set-start').emit('click');
  assert.match(h.element('notice').textContent,/온라인 지도를 켠 뒤/);assert.equal(open(),false,'set-start itself collapses the sheet');
  // Still showing: the same text again, or new text, does not pull the sheet back up.
  await h.element('disable-map').emit('click');
  assert.match(h.element('notice').textContent,/온라인 지도를 껐어요/);assert.equal(open(),false);
  await h.element('notice').emit('click');assert.equal(h.element('notice').textContent,'');
  await h.element('disable-map').emit('click');assert.equal(open(),true);
});
test('the GPS recovery box raises a collapsed sheet when it appears, not on every render',async()=>{
  const h=harness();const open=()=>h.document.body.classList.contains('sheet-open');
  await h.element('onboarding-skip').emit('click');
  h.element('gps-recovery').classList.add('hidden');h.element('notice').textContent='이미 보이는 안내';
  h.app.state.gpsIssue='위치 권한이 꺼져 있어요.';h.app.render();
  assert.equal(h.element('gps-recovery').classList.contains('hidden'),false);assert.equal(open(),true);
  await h.element('sheet-scrim').emit('click');h.app.render();h.tick();
  assert.equal(open(),false);
});
test('messages do not raise the sheet during the pace measurement, in demo mode or under a finger',async()=>{
  let dragging=false;
  const h=harness({dragging:()=>dragging});const open=()=>h.document.body.classList.contains('sheet-open');
  await h.element('disable-map').emit('click');assert.equal(open(),false,'pace measurement');
  await h.element('onboarding-skip').emit('click');await h.element('notice').emit('click');
  dragging=true;await h.element('disable-map').emit('click');assert.equal(open(),false,'dragging');
  dragging=false;await h.element('notice').emit('click');
  h.app.startDemo();await h.element('sheet-scrim').emit('click');
  h.mapClick(37.57,126.98);
  assert.match(h.element('notice').textContent,/가상 체험 중/);assert.equal(open(),false,'demo');
});

// Review round 3, 375x812: tap at y=560; the half height is 297 at first (sheet top 459), then the
// location messages arrive and it grows to 499 (sheet top 257, chips end at 108).
test('the pin stays above a sheet that grows after the destination was set',async()=>{
  const heights=[149,297,648];
  const h=await mapScreen({sheetHeights:heights,pin:{x:180,y:560}});
  h.mapClick(37.57,126.98);
  assert.equal(h.pin.y,419);
  heights[1]=499;h.app.render();
  assert.equal(h.pans.length,2);assert.equal(h.pin.y,217);
  assert.ok(h.pin.y>=108+40&&h.pin.y<=257-40,'the pin is outside the visible band');
  // Nothing moved since: later layouts leave the map alone.
  h.app.render();h.tick();assert.equal(h.pans.length,2);
});
test('once the user moves the map or drags the sheet, a growing sheet no longer moves the map',async()=>{
  for (const takeOver of [h=>h.element('map').emit('pointerdown'),h=>h.element('map').emit('wheel'),h=>h.element('map').emit('touchstart'),async h=>h.dragSheet()]) {
    const heights=[149,297,648];
    const h=await mapScreen({sheetHeights:heights,pin:{x:180,y:560}});
    h.mapClick(37.57,126.98);assert.equal(h.pans.length,1);
    await takeOver(h);
    heights[1]=499;h.app.render();h.tick();
    assert.equal(h.pans.length,1);assert.equal(h.pin.y,419);
  }
});
test('a fitted route, a cleared destination and a new destination each end the old follow-up',async()=>{
  const heights=[149,297,648];
  const routed=await mapScreen({sheetHeights:heights,pin:{x:180,y:560},getWalkingRoutes:async(start,end)=>[{points:[start,end],distance:300,snapDistance:0}]});
  routed.app.state.position=[37.56,126.97];routed.app.state.routeConsent=true;
  routed.mapClick(37.561,126.97);await flushAsync();await flushAsync();
  assert.notEqual(routed.app.state.route,null);const fitted=routed.pans.length;
  heights[1]=499;routed.app.render();assert.equal(routed.pans.length,fitted);

  const cleared=await mapScreen({sheetHeights:[149,297,648],pin:{x:180,y:560}});
  cleared.mapClick(37.57,126.98);await cleared.element('clear-destination').emit('click');
  const before=cleared.pans.length;cleared.app.render();cleared.tick();assert.equal(cleared.pans.length,before);
});
test('a band too low for both margins holds the pin in its middle; a covered map is left alone',async()=>{
  // Sheet box 108..508 (short screen). Half height 340: the band is 108..168, 60px.
  const low=await mapScreen({sheetHeights:[149,340,400],pin:{x:180,y:300}});
  Object.assign(low.element('sheet'),{offsetTop:108,offsetHeight:400});
  low.mapClick(37.57,126.98);
  assert.equal(low.pin.y,138);
  const covered=await mapScreen({sheetHeights:[149,390,400],pin:{x:180,y:300}});
  Object.assign(covered.element('sheet'),{offsetTop:108,offsetHeight:400});
  covered.mapClick(37.57,126.98);
  assert.deepEqual(covered.pans,[]);
});
