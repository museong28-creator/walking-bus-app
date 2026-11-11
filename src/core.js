export const EARTH_RADIUS = 6371008.8;
export const DEFAULT_SPEED = 1.2;
export const MAX_WALK_SPEED = 4.5;

export function isCoordinate(point) {
  return Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)
    && Math.abs(point[0]) <= 90 && Math.abs(point[1]) <= 180;
}

export function distance(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pathDistance(points) {
  return points.slice(1).reduce((sum, point, index) => sum + distance(points[index], point), 0);
}

export function projectOnRoute(position, points, totalDistance = pathDistance(points)) {
  if (!isCoordinate(position) || points.length < 2 || !points.every(isCoordinate)) return null;
  const rad = Math.PI / 180;
  const xScale = EARTH_RADIUS * rad * Math.cos(position[0] * rad);
  const yScale = EARTH_RADIUS * rad;
  let along = 0, best = null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const ax = (a[1] - position[1]) * xScale, ay = (a[0] - position[0]) * yScale;
    const bx = (b[1] - position[1]) * xScale, by = (b[0] - position[0]) * yScale;
    const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy;
    const t = length2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2)) : 0;
    const offset = Math.hypot(ax + t * dx, ay + t * dy);
    const length = distance(a, b);
    if (!best || offset < best.offset) best = {offset, along: along + t * length};
    along += length;
  }
  const fraction = along > 0 ? Math.max(0, Math.min(1, best.along / along)) : 0;
  return {offset: best.offset, fraction, remaining: Math.max(0, totalDistance * (1 - fraction))};
}

export function etaSeconds(meters, metersPerSecond) {
  if (!Number.isFinite(meters) || meters < 0 || !Number.isFinite(metersPerSecond) || metersPerSecond < 0.25) return null;
  return Math.ceil(meters / metersPerSecond);
}

export function catchStatus(arrivalTime, secondsToStop, now, bufferSeconds = 60) {
  if (!Number.isFinite(arrivalTime) || !Number.isFinite(now) || !Number.isFinite(bufferSeconds) || bufferSeconds < 0) return {kind: 'unknown'};
  if (arrivalTime <= now) return {kind: 'expired'};
  if (!Number.isFinite(secondsToStop) || secondsToStop < 0) return {kind: 'unknown'};
  const margin = Math.floor((arrivalTime - now) / 1000 - secondsToStop - bufferSeconds);
  return {kind: margin >= 0 ? 'possible' : 'tight', margin};
}

export function parseCoordinates(value) {
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const point = [Number(match[1]), Number(match[2])];
  return isCoordinate(point) ? point : null;
}

export class SpeedTracker {
  constructor() { this.reset(); }
  reset() {
    this.samples = [];
    this.lastFix = null;
    this.anchor = null;
    this.lastMovement = null;
    this.current = null;
    this.learned = null;
    this.status = 'waiting';
  }
  ingest(fix) {
    const {latitude, longitude, accuracy, speed, timestamp} = fix;
    if (!isCoordinate([latitude, longitude]) || !Number.isFinite(timestamp) || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 40) {
      this.status = 'inaccurate'; return false;
    }
    if (this.lastFix && timestamp <= this.lastFix.timestamp) return false;
    const point = [latitude, longitude];
    if (this.lastFix) {
      const dt = (timestamp - this.lastFix.timestamp) / 1000;
      if (dt > 30) { this.samples = []; this.anchor = null; this.current = null; }
      else if (dt > 0 && distance(this.lastFix.point, point) > MAX_WALK_SPEED * dt + accuracy + this.lastFix.accuracy) {
        this.status = 'jump'; return false;
      }
    }
    this.lastFix = {point, accuracy, timestamp};
    if (!this.anchor) this.anchor = {point, accuracy, timestamp};
    let measured = null;
    if (typeof speed === 'number' && Number.isFinite(speed) && speed >= 0) {
      if (speed > MAX_WALK_SPEED) { this.current = null; this.status = 'too-fast'; return true; }
      measured = speed;
    } else {
      const elapsed = (timestamp - this.anchor.timestamp) / 1000;
      const traveled = distance(this.anchor.point, point);
      const noise = Math.max(6, (accuracy + this.anchor.accuracy) * 0.35);
      if (elapsed >= 8 && traveled >= noise) {
        measured = traveled / elapsed;
        this.anchor = {point, accuracy, timestamp};
        if (measured > MAX_WALK_SPEED) { this.current = null; this.status = 'too-fast'; return true; }
      } else if (elapsed >= 15 && traveled < noise) measured = 0;
    }
    if (measured !== null) {
      this.samples.push({value: measured, timestamp});
      this.samples = this.samples.filter(sample => timestamp - sample.timestamp <= 25000);
      const recent = this.samples.slice(-3);
      const stopped = recent.length >= 2 && recent.every(sample => sample.value < 0.25);
      const weights = this.samples.map((sample, index) => index + 1);
      this.current = stopped ? 0 : this.samples.reduce((sum, sample, index) => sum + sample.value * weights[index], 0) / weights.reduce((a, b) => a + b, 0);
      if (this.current >= 0.4) this.learned = this.current;
      this.status = stopped || this.current < 0.25 ? 'stopped' : 'measured';
    } else this.status = this.current === null ? 'measuring' : this.status;
    return true;
  }
}
