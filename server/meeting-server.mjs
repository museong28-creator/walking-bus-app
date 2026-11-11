import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const MAX_ROOM_TTL_MS = 24 * 60 * 60 * 1000;
export const STALE_AFTER_MS = 30_000;
export const REMOVE_AFTER_MS = 90_000;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{24}$/;
const DEFAULT_ORIGINS = ['http://127.0.0.1:3000', 'http://localhost:3000'];
const API_ROUTES = new Set([
  '/api/rooms/create', '/api/rooms/join', '/api/rooms/snapshot',
  '/api/rooms/sharing/start', '/api/rooms/position', '/api/rooms/sharing/stop',
  '/api/rooms/leave', '/api/rooms/close',
]);

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const credential = () => randomBytes(32).toString('base64url');
const identifier = () => randomBytes(18).toString('base64url');
const digest = value => createHash('sha256').update(value).digest();
const sameCredential = (supplied, expectedDigest) => {
  // Always compare equal-length digests. Never keep raw long-lived bearer tokens.
  const actual = digest(typeof supplied === 'string' ? supplied : '');
  return timingSafeEqual(actual, expectedDigest) && typeof supplied === 'string' && TOKEN_PATTERN.test(supplied);
};
const normalizeIp = value => String(value ?? '').replace(/^::ffff:/, '');
const loopbackIp = value => ['127.0.0.1', '::1'].includes(normalizeIp(value));
const localhostHost = value => /^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(value ?? '');
const validInteger = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function textValue(value, max, label) {
  if (typeof value !== 'string') fail(400, 'invalid_input', `${label} is required.`);
  const clean = value.trim();
  if (!clean || [...clean].length > max || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(clean)) {
    fail(400, 'invalid_input', `${label} must contain 1–${max} characters without control characters.`);
  }
  return clean;
}
function pointValue(value) {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite)
      || value[0] < -90 || value[0] > 90 || value[1] < -180 || value[1] > 180) {
    fail(400, 'invalid_input', 'point must be [latitude, longitude] within geographic bounds.');
  }
  return [...value];
}
function boundedNumber(value, max, label, nullable = false) {
  if (nullable && value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > max) {
    fail(400, 'invalid_input', `${label} must be ${nullable ? 'null or ' : ''}a finite nonnegative number at most ${max}.`);
  }
  return value;
}
function originValue(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('ALLOWED_ORIGINS must contain exact http(s) origins.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value
      || (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) {
    throw new Error('ALLOWED_ORIGINS must be exact HTTPS origins, except HTTP localhost. Wildcards and paths are forbidden.');
  }
  return value;
}

function readJson(req, maxBytes) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] ?? '')) {
    fail(415, 'json_required', 'Use Content-Type: application/json.');
  }
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    fail(415, 'encoding_not_supported', 'Compressed request bodies are not accepted.');
  }
  if (Number(req.headers['content-length']) > maxBytes) fail(413, 'body_too_large', 'Request body is too large.');
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    let finished = false;
    const done = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAbort);
      if (error) { req.resume(); reject(error); } else resolve(result);
    };
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) done(new ApiError(413, 'body_too_large', 'Request body is too large.'));
      else chunks.push(chunk);
    };
    const onEnd = () => {
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { done(new ApiError(400, 'invalid_json', 'Request body must contain valid JSON.')); return; }
      if (!object(parsed)) { done(new ApiError(400, 'invalid_json', 'Request body must be a JSON object.')); return; }
      done(null, parsed);
    };
    const onError = () => done(new ApiError(400, 'invalid_request', 'Request could not be read.'));
    const onAbort = () => done(new ApiError(400, 'invalid_request', 'Request was interrupted.'));
    const timer = setTimeout(() => done(new ApiError(408, 'request_timeout', 'Request body timed out.')), 10_000);
    timer.unref();
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError); req.once('aborted', onAbort);
  });
}

/** In-memory, single-process meeting API. No database, account service, or location log. */
export function createMeetingServer(options = {}) {
  const now = options.now ?? Date.now;
  const roomTtlMs = options.roomTtlMs ?? DEFAULT_TTL_MS;
  const maxRooms = options.maxRooms ?? 1_000;
  const maxBodyBytes = options.maxBodyBytes ?? 8_192;
  if (!validInteger(roomTtlMs, 1_000, MAX_ROOM_TTL_MS)) throw new Error('roomTtlMs must be between 1000 and 86400000.');
  if (!validInteger(maxRooms, 1, 5_000)) throw new Error('maxRooms must be between 1 and 5000.');
  if (!validInteger(maxBodyBytes, 256, 65_536)) throw new Error('maxBodyBytes must be between 256 and 65536.');
  const allowedOrigins = new Set((options.allowedOrigins ?? DEFAULT_ORIGINS).map(originValue));
  const trustedProxyIps = new Set((options.trustedProxyIps ?? []).map(value => {
    if (!isIP(value)) throw new Error('trustedProxyIps must contain exact IP addresses.');
    return normalizeIp(value);
  }));
  const rooms = new Map();
  const rateBuckets = new Map();
  const limits = {
    requestsPerMinute: options.rateLimits?.requestsPerMinute ?? 300,
    createsPerHour: options.rateLimits?.createsPerHour ?? 10,
    joinsPerMinute: options.rateLimits?.joinsPerMinute ?? 30,
    memberRequestsPerMinute: options.rateLimits?.memberRequestsPerMinute ?? 180,
    publishesPerMinute: options.rateLimits?.publishesPerMinute ?? 60,
  };
  for (const value of Object.values(limits)) if (!validInteger(value, 1, 100_000)) throw new Error('Rate limits must be positive bounded integers.');

  function stopSharing(member) {
    member.position = null; member.shareEpochDigest = null; member.sharing = false; member.sequence = 0;
  }
  function sweep(at) {
    for (const [id, room] of rooms) {
      if (at >= room.expiresAt) { rooms.delete(id); continue; }
      for (const member of room.members.values()) {
        // A sharing lease also expires if a client opts in but never publishes.
        const lastPositionAt = member.position?.receivedAt ?? member.sharingStartedAt;
        if (member.sharing && at - lastPositionAt >= REMOVE_AFTER_MS) stopSharing(member);
      }
    }
    for (const [key, bucket] of rateBuckets) if (at >= bucket.resetAt) rateBuckets.delete(key);
  }
  function limit(key, maximum, windowMs, at) {
    let bucket = rateBuckets.get(key);
    if (!bucket || at >= bucket.resetAt) {
      if (rateBuckets.size >= 10_000) fail(503, 'busy', 'The server is busy. Try later.');
      bucket = { count: 0, resetAt: at + windowMs }; rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > maximum) fail(429, 'rate_limited', 'Too many requests. Try later.');
  }
  function bearer(req) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '');
    return match?.[1] ?? '';
  }
  function roomFor(body) {
    if (typeof body.roomId !== 'string' || !ID_PATTERN.test(body.roomId)) fail(400, 'invalid_input', 'A valid roomId is required.');
    const room = rooms.get(body.roomId);
    if (!room) fail(404, 'room_unavailable', 'This room is unavailable or has expired.');
    return room;
  }
  function memberFor(req, room, body, at) {
    const member = typeof body.memberId === 'string' ? room.members.get(body.memberId) : undefined;
    if (!member || !sameCredential(bearer(req), member.tokenDigest)) fail(401, 'unauthorized', 'Valid member credentials are required.');
    limit(`member:${room.id}:${member.id}`, limits.memberRequestsPerMinute, 60_000, at);
    return member;
  }
  function addMember(room, name, at) {
    const memberToken = credential();
    const member = {
      id: identifier(), name, tokenDigest: digest(memberToken), sharing: false,
      position: null, shareEpochDigest: null, sequence: 0, sharingStartedAt: null, lastSeenAt: at,
    };
    room.members.set(member.id, member);
    return { member, memberToken };
  }
  function snapshot(room, at) {
    return {
      roomId: room.id, serverTime: at, destination: room.destination, meetingAt: room.meetingAt,
      createdAt: room.createdAt, expiresAt: room.expiresAt, hostMemberId: room.hostMemberId,
      members: [...room.members.values()].map(member => ({
        id: member.id, name: member.name, sharing: member.sharing, lastSeenAt: member.lastSeenAt,
        ...(member.position ? { position: member.position, stale: at - Math.min(member.position.recordedAt, member.position.receivedAt) >= STALE_AFTER_MS } : {}),
      })),
    };
  }

  const server = http.createServer({ maxHeaderSize: 8_192 }, async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Vary', 'Origin');
    const send = (status, value) => {
      if (!res.destroyed && !res.writableEnded) { res.statusCode = status; res.end(JSON.stringify(value)); }
    };
    try {
      const atBeforeRead = now();
      sweep(atBeforeRead);
      const peerIp = normalizeIp(req.socket.remoteAddress);
      limit(`ip:${peerIp}`, limits.requestsPerMinute, 60_000, atBeforeRead);
      const proxyHttps = trustedProxyIps.has(peerIp) && req.headers['x-forwarded-proto'] === 'https';
      const directLocal = loopbackIp(peerIp) && localhostHost(req.headers.host);
      if (!(req.socket.encrypted || proxyHttps || directLocal)) fail(426, 'https_required', 'Use HTTPS through a trusted reverse proxy.');
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins.has(origin)) fail(403, 'origin_not_allowed', 'This origin is not allowed.');
      if (origin !== undefined) res.setHeader('Access-Control-Allow-Origin', origin);
      // Query strings are deliberately forbidden, including credentials accidentally put in URLs.
      if (!API_ROUTES.has(req.url)) fail(404, 'not_found', 'API route not found.');
      if (req.method === 'OPTIONS') {
        if (req.headers['access-control-request-method'] !== 'POST') fail(405, 'method_not_allowed', 'Use POST.');
        const requestedHeaders = String(req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
        if (requestedHeaders.some(header => !['authorization', 'content-type'].includes(header))) fail(403, 'headers_not_allowed', 'Requested headers are not allowed.');
        res.setHeader('Access-Control-Allow-Methods', 'POST');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Max-Age', '300');
        res.statusCode = 204; res.end(); return;
      }
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); fail(405, 'method_not_allowed', 'Use POST with a JSON body.'); }
      const body = await readJson(req, maxBodyBytes);
      const at = now();
      sweep(at); // Recheck after body read: expiry or stop may have happened while this request was pending.
      if (req.url === '/api/rooms/create') {
        limit(`create:${peerIp}`, limits.createsPerHour, 3_600_000, at);
        if (rooms.size >= maxRooms) fail(503, 'room_capacity', 'The server cannot create another room right now.');
        const displayName = textValue(body.displayName, 24, 'displayName');
        if (!object(body.destination)) fail(400, 'invalid_input', 'destination is required.');
        const destination = { name: textValue(body.destination.name, 120, 'destination.name'), point: pointValue(body.destination.point) };
        const meetingAt = body.meetingAt ?? null;
        if (meetingAt !== null && !validInteger(meetingAt, 0, Number.MAX_SAFE_INTEGER)) fail(400, 'invalid_input', 'meetingAt must be an epoch millisecond integer or null.');
        const inviteToken = credential();
        const room = { id: identifier(), inviteDigest: digest(inviteToken), destination, meetingAt, createdAt: at, expiresAt: at + roomTtlMs, members: new Map() };
        const { member, memberToken } = addMember(room, displayName, at);
        room.hostMemberId = member.id; rooms.set(room.id, room);
        send(201, { roomId: room.id, inviteToken, memberId: member.id, memberToken, expiresAt: room.expiresAt }); return;
      }
      const room = roomFor(body);
      if (req.url === '/api/rooms/join') {
        limit(`join:${peerIp}`, limits.joinsPerMinute, 60_000, at);
        if (!sameCredential(bearer(req), room.inviteDigest)) fail(401, 'unauthorized', 'A valid invitation is required.');
        const displayName = textValue(body.displayName, 24, 'displayName');
        if (room.members.size >= 8) fail(409, 'room_full', 'This room already has eight participants.');
        const { member, memberToken } = addMember(room, displayName, at);
        send(201, { roomId: room.id, memberId: member.id, memberToken, expiresAt: room.expiresAt }); return;
      }
      const member = memberFor(req, room, body, at);
      if (req.url === '/api/rooms/snapshot') {
        member.lastSeenAt = at; send(200, snapshot(room, at)); return;
      }
      if (req.url === '/api/rooms/sharing/start') {
        const shareEpoch = credential();
        stopSharing(member); member.sharing = true; member.sharingStartedAt = at;
        member.shareEpochDigest = digest(shareEpoch); member.lastSeenAt = at;
        send(200, { shareEpoch }); return;
      }
      if (req.url === '/api/rooms/sharing/stop') {
        stopSharing(member); member.lastSeenAt = at; send(200, { sharing: false }); return;
      }
      if (req.url === '/api/rooms/position') {
        limit(`publish:${room.id}:${member.id}`, limits.publishesPerMinute, 60_000, at);
        if (!member.sharing || !member.shareEpochDigest || !sameCredential(body.shareEpoch, member.shareEpochDigest)) {
          fail(409, 'sharing_inactive', 'Sharing has stopped or this sharing session has expired. Start sharing again explicitly.');
        }
        if (!validInteger(body.sequence, 1, Number.MAX_SAFE_INTEGER)) fail(400, 'invalid_input', 'sequence must be a positive safe integer.');
        if (body.sequence <= member.sequence) fail(409, 'sequence_replayed', 'This position is older than the accepted sequence.');
        if (!object(body.position)) fail(400, 'invalid_input', 'position is required.');
        const position = {
          point: pointValue(body.position.point),
          accuracy: boundedNumber(body.position.accuracy, 10_000, 'accuracy'),
          speedMps: boundedNumber(body.position.speedMps, 30, 'speedMps', true),
          etaSeconds: boundedNumber(body.position.etaSeconds, 86_400, 'etaSeconds', true),
          recordedAt: body.position.recordedAt,
          receivedAt: at,
        };
        if (!validInteger(position.recordedAt, 0, Number.MAX_SAFE_INTEGER)) fail(400, 'invalid_input', 'recordedAt must be an epoch millisecond integer.');
        if (position.recordedAt < at - STALE_AFTER_MS) fail(422, 'stale_position', 'This position was recorded too long ago.');
        if (position.recordedAt > at + 5_000) fail(422, 'future_position', 'This position timestamp is in the future.');
        if (member.position && position.recordedAt < member.position.recordedAt) fail(409, 'position_reordered', 'This position predates the last accepted position.');
        member.position = position; member.sequence = body.sequence; member.lastSeenAt = at;
        send(200, { accepted: true, receivedAt: at, sequence: body.sequence }); return;
      }
      if (req.url === '/api/rooms/leave') {
        stopSharing(member); room.members.delete(member.id);
        const closed = room.hostMemberId === member.id;
        if (closed) rooms.delete(room.id);
        send(200, { left: true, ...(closed ? { closed: true } : {}) }); return;
      }
      if (req.url === '/api/rooms/close') {
        if (member.id !== room.hostMemberId) fail(403, 'host_required', 'Only the host may close this room.');
        rooms.delete(room.id); send(200, { closed: true }); return;
      }
    } catch (error) {
      // Deliberately do not log requests, error stacks, credentials, or coordinates.
      if (error instanceof ApiError) {
        if (error.status === 429) res.setHeader('Retry-After', '60');
        if ([408, 413].includes(error.status)) res.setHeader('Connection', 'close');
        send(error.status, { error: { code: error.code, message: error.message } });
      } else send(500, { error: { code: 'internal_error', message: 'The request could not be completed.' } });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 30;
  server.maxRequestsPerSocket = 100;
  const interval = setInterval(() => sweep(now()), 1_000);
  interval.unref();
  server.on('close', () => { clearInterval(interval); rooms.clear(); rateBuckets.clear(); });
  return server;
}

function integerEnv(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  if (!/^\d+$/.test(process.env[name])) throw new Error(`${name} must be a positive integer.`);
  return Number(process.env[name]);
}
export function configFromEnv(env = process.env) {
  // Accept an explicit environment argument without changing global process.env.
  const number = (name, fallback) => {
    if (env[name] === undefined) return fallback;
    if (!/^\d+$/.test(env[name])) throw new Error(`${name} must be a positive integer.`);
    return Number(env[name]);
  };
  return {
    roomTtlMs: number('ROOM_TTL_MS', DEFAULT_TTL_MS),
    maxRooms: number('MAX_ROOMS', 1_000),
    allowedOrigins: env.ALLOWED_ORIGINS === undefined ? DEFAULT_ORIGINS : env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean),
    trustedProxyIps: (env.TRUSTED_PROXY_IPS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const host = process.env.HOST ?? '127.0.0.1';
    const port = integerEnv('PORT', 8787);
    if (!validInteger(port, 1, 65_535)) throw new Error('PORT must be between 1 and 65535.');
    const server = createMeetingServer(configFromEnv());
    server.listen(port, host, () => {
      console.log(`Meeting API listening on ${host}:${port}. Room state is temporary and memory-only.`);
    });
    server.on('error', () => { console.error('Meeting API could not start. Check the bind address and port.'); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeIdleConnections(); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
