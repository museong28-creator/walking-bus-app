import test from 'node:test';
import assert from 'node:assert/strict';
import {nearestSnap} from '../src/sheet.js';

const points = [100, 320, 700];

test('a slow release settles on the nearest height', () => {
  assert.equal(nearestSnap(130, 0, points), 0);
  assert.equal(nearestSnap(240, 0.1, points), 1);
  assert.equal(nearestSnap(600, -0.1, points), 2);
});

test('a flick moves one step in its direction, however short the drag', () => {
  assert.equal(nearestSnap(110, 1, points), 1);
  assert.equal(nearestSnap(330, 1, points), 2);
  assert.equal(nearestSnap(690, -1, points), 1);
  assert.equal(nearestSnap(310, -1, points), 0);
});

test('a flick past the last height stays there', () => {
  assert.equal(nearestSnap(700, 1, points), 2);
  assert.equal(nearestSnap(100, -1, points), 0);
});
