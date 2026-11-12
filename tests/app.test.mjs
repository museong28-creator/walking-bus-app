import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setImmediate as flushAsync} from 'node:timers/promises';
import vm from 'node:vm';
import * as core from '../src/core.js';
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
    visibilityState: 'visible', getElementById: element, createElement: tagName => new FakeElement(tagName),
  });
  const window = Object.assign(new FakeTarget(), {isSecureContext: options.secure ?? true});
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
  const map = {...layer(), setView() { return this; }, fitBounds() { return this; }};
  const L = {map: () => map, control: {zoom: () => layer()}, tileLayer: layer, layerGroup: layer,
    polyline: layer, marker: layer, divIcon: value => value, latLngBounds: value => value};
  class ClockDate extends Date { static now() { return now; } }
  const context = vm.createContext({
    ...core, SERVICES, document, window, navigator, L, Date: ClockDate, Intl, AbortController, console,
    setInterval: callback => { intervals.push(callback); return intervals.length; },
    getWalkingRoute: async () => {throw new Error('Unexpected network request');},
    searchPlaces: async () => {throw new Error('Unexpected network request');},
    getNearbyStops: async () => {throw new Error('Unexpected network request');},
    initMeetupUI: () => ({refresh() {},pauseSharing() {},destinationChanged() {},useBusTime(timestamp) {busTargets.push(timestamp);}}),
  });
  vm.runInContext(appSource, context, {filename: 'src/app.js'});
  return {
    app: context.appTest, element, document, window, navigator, watches, cleared, busTargets,
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
  assert.match(h.element('onboarding-feedback').textContent,/측정 완료/);
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
