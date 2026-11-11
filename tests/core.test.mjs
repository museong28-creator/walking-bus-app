import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EARTH_RADIUS, MAX_WALK_SPEED, SpeedTracker, isCoordinate, distance,
  pathDistance, projectOnRoute, etaSeconds, catchStatus, parseCoordinates,
} from '../src/core.js';

const degreesPerMeter = 180 / (Math.PI * EARTH_RADIUS);
const north = meters => [meters * degreesPerMeter, 0];
const fix = (seconds, meters = 0, speed = null, accuracy = 5) => ({
  latitude: north(meters)[0], longitude: 0, accuracy, speed,
  timestamp: 1_000_000 + seconds * 1000,
});
const close = (actual, expected, epsilon = 0.01) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} should be within ${epsilon} of ${expected}`);
};

test('coordinate validation requires finite numeric latitude and longitude in bounds', () => {
  for (const value of [[0, 0], [90, 180], [-90, -180], [37.5665, 126.978]]) assert.equal(isCoordinate(value), true);
  for (const value of [null, {}, [0], [0, 0, 0], [91, 0], [0, 181], [NaN, 0], [Infinity, 0], ['0', 0]]) assert.equal(isCoordinate(value), false);
});

test('coordinate parsing handles spaces and rejects unsupported or out-of-bounds input', () => {
  assert.deepEqual(parseCoordinates(' 37.5665, 126.9780 '), [37.5665, 126.978]);
  assert.deepEqual(parseCoordinates('-90, -180'), [-90, -180]);
  for (const value of ['', 'Seoul', '91,0', '0,181', '0,0,1', 'NaN,0', '1e2,0']) assert.equal(parseCoordinates(value), null);
});

test('distance and pathDistance use meters without adding nonexistent segments', () => {
  assert.equal(distance(north(0), north(0)), 0);
  close(distance(north(0), north(100)), 100);
  close(distance(north(100), north(0)), 100);
  close(pathDistance([north(0), north(100), north(300)]), 300);
  assert.equal(pathDistance([]), 0);
  assert.equal(pathDistance([north(0)]), 0);
});

test('route projection scales remaining distance by authoritative route length', () => {
  const result = projectOnRoute(north(25), [north(0), north(100)], 120);
  close(result.offset, 0);
  close(result.fraction, 0.25);
  close(result.remaining, 90);
});

test('route projection follows accumulated segment length rather than direct endpoint distance', () => {
  const points = [north(0), north(100), [north(100)[0], 100 * degreesPerMeter]];
  const result = projectOnRoute([north(100)[0], 50 * degreesPerMeter], points, 200);
  close(result.offset, 0);
  close(result.fraction, 0.75);
  close(result.remaining, 50);
});

test('route projection measures lateral offset and clamps before/after the route', () => {
  close(projectOnRoute([north(50)[0], 20 * degreesPerMeter], [north(0), north(100)]).offset, 20);
  assert.equal(projectOnRoute(north(-10), [north(0), north(100)]).fraction, 0);
  assert.equal(projectOnRoute(north(110), [north(0), north(100)]).remaining, 0);
});

test('route projection tolerates duplicate vertices and rejects invalid coordinate data', () => {
  close(projectOnRoute(north(50), [north(0), north(0), north(100)]).remaining, 50);
  assert.equal(projectOnRoute(north(0), []), null);
  assert.equal(projectOnRoute(north(0), [north(0)]), null);
  assert.equal(projectOnRoute([91, 0], [north(0), north(100)]), null);
  assert.equal(projectOnRoute(north(0), [[0, 0], [NaN, 0]], 100), null);
});

test('ETA rounds up seconds and never manufactures a walking speed while paused or unknown', () => {
  assert.equal(etaSeconds(101, 2), 51);
  assert.equal(etaSeconds(0, 1.2), 0);
  for (const speed of [null, undefined, 0, 0.249, -1, NaN, Infinity, '1.2']) assert.equal(etaSeconds(100, speed), null);
  for (const meters of [-1, NaN, Infinity, null]) assert.equal(etaSeconds(meters, 1.2), null);
  assert.equal(etaSeconds(1, 0.25), 4);
});

test('null GPS speed means not yet measured, whereas numeric zero means stopped', () => {
  const unknown = new SpeedTracker();
  assert.equal(unknown.ingest(fix(0)), true);
  assert.equal(unknown.current, null);
  assert.equal(unknown.status, 'measuring');
  const stopped = new SpeedTracker();
  stopped.ingest(fix(0, 0, 0));
  assert.equal(stopped.current, 0);
  assert.equal(stopped.status, 'stopped');
  assert.equal(etaSeconds(100, stopped.current), null);
});

test('GPS zero is authoritative and is not replaced by coordinate-derived movement', () => {
  const tracker = new SpeedTracker();
  tracker.ingest(fix(0, 0, 0));
  tracker.ingest(fix(10, 12, 0));
  assert.equal(tracker.current, 0);
  assert.equal(tracker.status, 'stopped');
});

test('missing or invalid native speed can be derived from sufficiently long displacement', () => {
  for (const speed of [null, undefined, -1, NaN, '1.2']) {
    const tracker = new SpeedTracker();
    tracker.ingest(fix(0, 0, speed));
    tracker.ingest(fix(10, 12, speed));
    close(tracker.current, 1.2);
    assert.equal(tracker.status, 'measured');
  }
});

test('small GPS noise is not mistaken for walking', () => {
  const tracker = new SpeedTracker();
  tracker.ingest(fix(0));
  tracker.ingest(fix(8, 2));
  assert.equal(tracker.current, null);
  tracker.ingest(fix(16, 3));
  assert.equal(tracker.current, 0);
  assert.equal(tracker.status, 'stopped');
});

test('the accuracy-dependent noise floor suppresses poor-accuracy drift', () => {
  const tracker = new SpeedTracker();
  tracker.ingest(fix(0, 0, null, 30));
  tracker.ingest(fix(10, 15, null, 30));
  assert.equal(tracker.current, null);
  tracker.ingest(fix(16, 15, null, 30));
  assert.equal(tracker.current, 0);
});

test('reject inaccurate and malformed fixes without replacing the last accepted location', () => {
  const tracker = new SpeedTracker();
  tracker.ingest(fix(0, 0, 1.2));
  const accepted = tracker.lastFix;
  for (const bad of [fix(1, 1, null, 41), fix(1, 1, null, -1), {...fix(1), latitude: 91}, {...fix(1), timestamp: NaN}]) {
    assert.equal(tracker.ingest(bad), false);
    assert.equal(tracker.lastFix, accepted);
    assert.equal(tracker.status, 'inaccurate');
  }
});

test('out-of-order and duplicate timestamps cannot alter current speed or anchor', () => {
  const tracker = new SpeedTracker();
  tracker.ingest(fix(10, 0, 1.2));
  const before = structuredClone(tracker);
  assert.equal(tracker.ingest(fix(9, 10, 0)), false);
  assert.equal(tracker.ingest(fix(10, 10, 0)), false);
  assert.deepEqual({...tracker}, before);
});

test('implausible position jumps are rejected and do not poison later valid fixes', () => {
  const tracker = new SpeedTracker();
  tracker.ingest(fix(0, 0, 1.2));
  assert.equal(tracker.ingest(fix(1, 200, 1.2)), false);
  assert.equal(tracker.status, 'jump');
  assert.equal(tracker.lastFix.timestamp, fix(0).timestamp);
  assert.equal(tracker.ingest(fix(2, 2.4, 1.2)), true);
  assert.equal(tracker.status, 'measured');
  close(tracker.current, 1.2);
});

test('a GPS gap over 30 seconds resets the measured speed and starts a fresh anchor', () => {
  const tracker = new SpeedTracker();
  tracker.ingest(fix(0, 0, 1.2));
  tracker.ingest(fix(31, 500));
  assert.equal(tracker.current, null);
  assert.equal(tracker.samples.length, 0);
  assert.equal(tracker.status, 'measuring');
  tracker.ingest(fix(41, 512));
  close(tracker.current, 1.2);
});

test('fresh native speed is usable immediately after a long GPS gap', () => {
  const tracker = new SpeedTracker();
  tracker.ingest(fix(0, 0, 3));
  tracker.ingest(fix(31, 500, 1));
  assert.equal(tracker.current, 1);
  assert.equal(tracker.samples.length, 1);
});

test('native speeds outside the supported walking range suspend ETA', () => {
  const tracker = new SpeedTracker();
  tracker.ingest(fix(0, 0, MAX_WALK_SPEED + 0.1));
  assert.equal(tracker.current, null);
  assert.equal(tracker.status, 'too-fast');
  assert.equal(etaSeconds(100, tracker.current), null);
});

test('smoothing converges to zero after consecutive stopped measurements', () => {
  const tracker = new SpeedTracker();
  tracker.ingest(fix(0, 0, 1.4));
  tracker.ingest(fix(1, 0, 0));
  tracker.ingest(fix(2, 0, 0));
  tracker.ingest(fix(3, 0, 0));
  assert.equal(tracker.current, 0);
  assert.equal(tracker.status, 'stopped');
  assert.equal(etaSeconds(300, tracker.current), null);
});

test('old samples fall out of the 25-second smoothing window', () => {
  const tracker = new SpeedTracker();
  tracker.ingest(fix(0, 0, 4));
  tracker.ingest(fix(26, 0, 1));
  assert.equal(tracker.current, 1);
  assert.equal(tracker.samples.length, 1);
});

test('reset clears past speed, learned pace, and location', () => {
  const tracker = new SpeedTracker();
  tracker.ingest(fix(0, 0, 1.2));
  tracker.reset();
  assert.deepEqual({...tracker}, {...new SpeedTracker()});
});

test('manual bus arrival stays fixed while its available walking margin counts down', () => {
  const enteredAt = 1_000_000;
  const arrival = enteredAt + 12 * 60_000;
  assert.deepEqual(catchStatus(arrival, 300, enteredAt), {kind: 'possible', margin: 360});
  assert.deepEqual(catchStatus(arrival, 300, enteredAt + 120_000), {kind: 'possible', margin: 240});
  assert.deepEqual(catchStatus(arrival, 300, enteredAt + 420_000), {kind: 'tight', margin: -60});
});

test('bus comparison includes a one-minute buffer and treats exact fit as possible', () => {
  assert.deepEqual(catchStatus(360_000, 300, 0), {kind: 'possible', margin: 0});
  assert.deepEqual(catchStatus(359_999, 300, 0), {kind: 'tight', margin: -1});
  assert.deepEqual(catchStatus(300_000, 300, 0, 0), {kind: 'possible', margin: 0});
});

test('future bus comparison remains unknown without a walking ETA', () => {
  for (const eta of [null, undefined, NaN, Infinity]) assert.deepEqual(catchStatus(600_000, eta, 0), {kind: 'unknown'});
  for (const arrival of [null, undefined, NaN, Infinity]) assert.deepEqual(catchStatus(arrival, 60, 0), {kind: 'unknown'});
});

test('bus time expires at its entered timestamp, even when walking ETA is unavailable', () => {
  assert.deepEqual(catchStatus(1000, 60, 1000), {kind: 'expired'});
  assert.deepEqual(catchStatus(1000, 60, 1001), {kind: 'expired'});
  assert.deepEqual(catchStatus(1000, null, 1001), {kind: 'expired'});
});

test('invalid bus comparison inputs cannot produce a confident catch verdict', () => {
  for (const args of [[600_000, -1, 0], [600_000, 60, NaN], [600_000, 60, undefined], [600_000, 60, 0, NaN]]) {
    assert.deepEqual(catchStatus(...args), {kind: 'unknown'});
  }
});
