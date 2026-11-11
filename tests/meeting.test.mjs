import test from 'node:test';
import assert from 'node:assert/strict';
import {assessDeadline, positionFreshness, localDateTimeValue} from '../src/meeting.js';

const now = 1_800_000_000_000;
const base = {remainingMeters:600, targetTime:now + 720_000, now, currentSpeedMps:1.2};
const assess = overrides => assessDeadline({...base,...overrides});
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} !== ${expected}`);

test('meeting timing subtracts the safety buffer using milliseconds and seconds correctly', () => {
  assert.deepEqual(assess(), {kind:'comfortable',requiredSpeedMps:1,requiredPaceSecondsPerKm:1000,marginSeconds:100,availableSeconds:600});
  const custom = assess({bufferSeconds:60});
  assert.equal(custom.availableSeconds, 660);
  close(custom.requiredSpeedMps, 600 / 660);
  close(custom.requiredPaceSecondsPerKm, 1100);
  assert.equal(custom.marginSeconds, 160);
});

test('required walking speed converts consistently into km/h and minutes per kilometer', () => {
  const result = assess({remainingMeters:1200,targetTime:now + 1_320_000});
  assert.equal(result.requiredSpeedMps * 3.6, 3.6);
  close(result.requiredPaceSecondsPerKm / 60, 16 + 2 / 3);
});

test('invalid inputs return only unknown/null values, even if distance appears arrived', () => {
  for (const bad of [
    {remainingMeters:-1}, {remainingMeters:NaN}, {remainingMeters:Infinity}, {remainingMeters:'600'},
    {targetTime:NaN}, {targetTime:Infinity}, {targetTime:null}, {now:NaN}, {now:undefined},
    {bufferSeconds:-1}, {bufferSeconds:Infinity}, {bufferSeconds:null},
    {comfortSpeedMps:0}, {comfortSpeedMps:-1}, {comfortSpeedMps:Infinity},
    {maxSuggestedMps:0}, {maxSuggestedMps:NaN}, {remainingMeters:0,targetTime:NaN},
  ]) {
    assert.deepEqual(assess(bad), {kind:'unknown',requiredSpeedMps:null,requiredPaceSecondsPerKm:null,marginSeconds:null,availableSeconds:null});
  }
});

test('zero remaining distance means arrived before expiry or speed checks', () => {
  for (const targetTime of [now - 1000,now,now + 1000]) {
    const result = assess({remainingMeters:0,targetTime,currentSpeedMps:null});
    assert.equal(result.kind, 'arrived');
    assert.equal(result.requiredSpeedMps, null);
    assert.equal(result.requiredPaceSecondsPerKm, null);
  }
});

test('target time at or before now is expired rather than a request for infinite speed', () => {
  for (const targetTime of [now,now - 1,now - 3_600_000]) {
    const result = assess({targetTime});
    assert.equal(result.kind, 'expired');
    assert.equal(result.requiredSpeedMps, null);
    assert.equal(result.marginSeconds, null);
  }
});

test('safety buffer consuming remaining time is late, not expired', () => {
  for (const seconds of [1,119,120]) {
    const result = assess({targetTime:now + seconds * 1000});
    assert.equal(result.kind, 'late');
    assert.equal(result.availableSeconds, seconds - 120);
    assert.equal(result.requiredSpeedMps, null);
    assert.equal(result.requiredPaceSecondsPerKm, null);
  }
});

test('a required pace above personal comfort is uncomfortable even below the absolute cap', () => {
  const result = assess({targetTime:now + 600_000});
  assert.equal(result.requiredSpeedMps, 1.25);
  assert.equal(result.kind, 'uncomfortable');
  assert.equal(result.marginSeconds, -20);
});

test('the conservative cap wins over an unusually high comfort setting', () => {
  const result = assess({remainingMeters:1008,targetTime:now + 720_000,comfortSpeedMps:2,maxSuggestedMps:1.67,currentSpeedMps:2});
  assert.equal(result.requiredSpeedMps, 1.68);
  assert.equal(result.kind, 'uncomfortable');
  assert.equal(assess({remainingMeters:1002,comfortSpeedMps:2,maxSuggestedMps:1.67,currentSpeedMps:1.67}).kind, 'tight');
});

test('uncomfortable classification takes precedence over unknown or late current pace', () => {
  for (const currentSpeedMps of [null,0,0.25,0.8]) {
    assert.equal(assess({targetTime:now + 600_000,currentSpeedMps}).kind, 'uncomfortable');
  }
});

test('missing or stopped speed preserves required pace but does not manufacture a current ETA', () => {
  for (const currentSpeedMps of [null,undefined,0,-1,0.249,NaN,Infinity,'1.2']) {
    const result = assess({currentSpeedMps});
    assert.equal(result.kind, 'unknown');
    assert.equal(result.marginSeconds, null);
    assert.equal(result.requiredSpeedMps, 1);
    assert.equal(result.requiredPaceSecondsPerKm, 1000);
  }
});

test('known slow walking estimates lateness without suggesting a faster-than-comfort pace', () => {
  const result = assess({currentSpeedMps:0.8});
  assert.equal(result.kind, 'late');
  assert.equal(result.marginSeconds, -150);
  assert.equal(result.requiredSpeedMps, 1);
  assert.equal(assess({currentSpeedMps:0.25}).kind, 'late');
});

test('zero margin is tight and 60 seconds of margin is comfortable', () => {
  assert.equal(assess({currentSpeedMps:1}).kind, 'tight');
  assert.equal(assess({currentSpeedMps:600 / 540}).kind, 'comfortable');
  assert.equal(assess({currentSpeedMps:600 / 540.1}).kind, 'tight');
});

test('a deadline recalculates as the clock advances while the absolute meeting time stays fixed', () => {
  assert.equal(assess().kind, 'comfortable');
  assert.equal(assess({now:now + 60_000}).kind, 'tight');
  assert.equal(assess({now:now + 120_000}).kind, 'uncomfortable');
  assert.equal(assess({now:now + 720_000}).kind, 'expired');
});

test('position freshness uses server receive time with exact 30-second and 90-second cutoffs', () => {
  assert.equal(positionFreshness({receivedAt:now},now), 'fresh');
  assert.equal(positionFreshness({receivedAt:now - 29_999},now), 'fresh');
  assert.equal(positionFreshness({receivedAt:now - 30_000},now), 'stale');
  assert.equal(positionFreshness({receivedAt:now - 89_999},now), 'stale');
  assert.equal(positionFreshness({receivedAt:now - 90_000},now), 'hidden');
  assert.equal(positionFreshness({receivedAt:now - 90_001},now), 'hidden');
});

test('missing or invalid position timestamps are hidden rather than assumed current', () => {
  for (const position of [null,undefined,{}, {receivedAt:null}, {receivedAt:'123'}, {receivedAt:NaN}, {receivedAt:Infinity}]) {
    assert.equal(positionFreshness(position,now), 'hidden');
  }
  assert.equal(positionFreshness({receivedAt:now},NaN), 'hidden');
});

test('small server clock skew does not create a negative age', () => {
  assert.equal(positionFreshness({receivedAt:now + 1000},now), 'fresh');
});

test('freshness uses the older recorded or received timestamp so transit delay cannot refresh an old fix', () => {
  assert.equal(positionFreshness({receivedAt:now,recordedAt:now - 30_000},now), 'stale');
  assert.equal(positionFreshness({receivedAt:now,recordedAt:now - 90_000},now), 'hidden');
  assert.equal(positionFreshness({receivedAt:now - 30_000,recordedAt:now},now), 'stale');
  assert.equal(positionFreshness({receivedAt:now - 90_000,recordedAt:now},now), 'hidden');
  assert.equal(positionFreshness({receivedAt:now,recordedAt:now - 29_999},now), 'fresh');
});

test('datetime-local formatting uses local calendar components and omits seconds/timezone suffixes', () => {
  const date = new Date(2026,1,3,4,5,59);
  assert.equal(localDateTimeValue(date.getTime()), '2026-02-03T04:05');
  assert.equal(localDateTimeValue(NaN), '');
  assert.equal(localDateTimeValue(Infinity), '');
});
