import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setImmediate as flushAsync} from 'node:timers/promises';
import vm from 'node:vm';
import * as core from '../src/core.js';
import {createMapAPI} from '../src/map-adapter.js';
import {SERVICES} from '../src/services.js';

// Run the actual application source with its external browser surfaces replaced.
// This tests event/state integration, not CSS layout, Leaflet rendering, or Safari APIs.
const appSource = (await readFile(new URL('../src/app.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '')
  + '\n;globalThis.appTest = {state, tracker, startTracking, stopTracking, setDestination, estimate, render, startDemo, exitDemo};';

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
  const watches = [], cleared = [], intervals = [], busTargets = [];
  const navigator = {
    geolocation: {
      watchPosition(success, failure, settings) { watches.push({success, failure, settings}); return watches.length; },
      clearWatch(id) { cleared.push(id); },
    },
  };
  if (options.wakeLock) navigator.wakeLock = options.wakeLock;
  if (options.noGeolocation) delete navigator.geolocation;
  const layer = () => ({
    addTo() { return this; }, remove() {}, clearLayers() {}, on() { return this; }, bindPopup() { return this; },
  });
  const mapEvents = new Map();
  const map = {...layer(), on(type, callback) { mapEvents.set(type,callback); return this; }, setView() { return this; }, fitBounds() { return this; }};
  const L = {map: () => map, control: {zoom: () => layer()}, tileLayer: layer, layerGroup: layer,
    polyline: layer, marker: layer, divIcon: value => value, latLngBounds: value => value};
  class ClockDate extends Date { static now() { return now; } }
  const context = vm.createContext({
    ...core, SERVICES, createMapAPI, KAKAO_JAVASCRIPT_KEY:'', document, window, navigator, L, Date: ClockDate, Intl, AbortController, console,
    setInterval: callback => { intervals.push(callback); return intervals.length; },
    getWalkingRoute: async () => {throw new Error('Unexpected network request');},
    searchPlaces: async () => {throw new Error('Unexpected network request');},
    getNearbyStops: options.getNearbyStops || (async () => {throw new Error('Unexpected network request');}),
    initAccountUI: () => ({}),
    initMeetupUI: () => ({refresh() {},pauseSharing() {},destinationChanged() {},useBusTime(timestamp) {busTargets.push(timestamp);}}),
  });
  vm.runInContext(appSource, context, {filename: 'src/app.js'});
  return {
    app: context.appTest, element, document, window, navigator, watches, cleared, busTargets, storage,
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
  assert.match(h.element('bus-result').children[0].textContent, /직접 입력 · 실시간 아님.*12분 후/);
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
test('onboarding calibrates from real moving samples then applies and stops GPS', async () => {
  const h=harness();await h.element('onboarding-start').emit('click');
  for(let i=0;i<7;i++){h.position({latitude:i*.000055,speed:1.2});if(i<6)h.advance(5000);}
  assert.equal(h.element('onboarding-finish').disabled,false);
  await h.element('onboarding-finish').emit('click');
  assert.equal(h.app.state.tracking,false);assert.equal(h.app.state.baseSpeed,1.2);
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
  assert.deepEqual(Object.keys(profile).sort(),['measuredAt','speed','version']);
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
