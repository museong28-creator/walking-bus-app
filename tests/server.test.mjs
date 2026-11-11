import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createMeetingServer, configFromEnv, MAX_ROOM_TTL_MS } from '../server/meeting-server.mjs';

const initialTime = 1_800_000_000_000;
const destination = { name: 'Synthetic meeting point', point: [37.5005, 127.0005] };
const route = name => `/api/rooms/${name}`;

async function fixture(t, options = {}) {
  let clock = initialTime;
  const server = createMeetingServer({ now: () => clock, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const call = async (name, body = {}, token, init = {}) => {
    const response = await fetch(base + route(name), {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
      body: JSON.stringify(body), ...Object.fromEntries(Object.entries(init).filter(([key]) => key !== 'headers')),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json(), headers: response.headers };
  };
  const create = async (displayName = 'Host') => {
    const result = await call('create', { displayName, destination, meetingAt: clock + 600_000 });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body;
  };
  const join = async (host, displayName = 'Guest') => {
    const result = await call('join', { roomId: host.roomId, displayName }, host.inviteToken);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body;
  };
  const member = (session, extra = {}) => ({ roomId: session.roomId, memberId: session.memberId, ...extra });
  const start = async session => {
    const result = await call('sharing/start', member(session), session.memberToken);
    assert.equal(result.status, 200);
    return result.body.shareEpoch;
  };
  const position = (extra = {}) => ({ point: [37.5001, 127.0001], accuracy: 8, speedMps: 1.2, etaSeconds: 360, recordedAt: clock, ...extra });
  return { server, base, call, create, join, member, start, position, advance: ms => { clock += ms; }, now: () => clock };
}

test('two independent sessions share only after explicit opt-in; snapshot excludes credentials', async t => {
  const f = await fixture(t);
  const host = await f.create('Mina');
  const guest = await f.join(host, 'Joon');
  for (const id of [host.roomId, host.memberId, guest.memberId]) assert.match(id, /^[A-Za-z0-9_-]{24}$/);
  assert.notEqual(host.memberToken, guest.memberToken);
  assert.match(host.inviteToken, /^[A-Za-z0-9_-]{43}$/);
  let result = await f.call('snapshot', f.member(guest), guest.memberToken);
  assert.equal(result.status, 200);
  assert.equal(result.body.serverTime, f.now());
  assert.equal(result.body.members.length, 2);
  assert.ok(result.body.members.every(m => m.sharing === false && !m.position));
  assert.equal((await f.call('position', f.member(host, { sequence: 1, position: f.position() }), host.memberToken)).body.error.code, 'sharing_inactive');
  const epoch = await f.start(host);
  result = await f.call('position', f.member(host, { shareEpoch: epoch, sequence: 1, position: f.position() }), host.memberToken);
  assert.equal(result.status, 200);
  result = await f.call('snapshot', f.member(guest), guest.memberToken);
  const visibleHost = result.body.members.find(m => m.id === host.memberId);
  assert.equal(visibleHost.sharing, true);
  assert.deepEqual(visibleHost.position.point, [37.5001, 127.0001]);
  assert.equal(visibleHost.position.etaSeconds, 360);
  assert.equal(visibleHost.position.receivedAt, f.now());
  assert.equal(visibleHost.stale, false);
  assert.ok(!result.body.members.find(m => m.id === guest.memberId).position);
  const serialized = JSON.stringify(result.body);
  for (const secret of [host.memberToken, guest.memberToken, host.inviteToken, epoch]) assert.ok(!serialized.includes(secret));
  assert.ok(!/token|digest|shareEpoch/i.test(serialized));
  assert.equal(result.headers.get('cache-control'), 'no-store, private');
  const guestEpoch = await f.start(guest);
  assert.equal((await f.call('position', f.member(guest, {
    shareEpoch: guestEpoch, sequence: 1, position: f.position({ point: [37.4999, 127.0003], etaSeconds: 480 }),
  }), guest.memberToken)).status, 200);
  const hostView = (await f.call('snapshot', f.member(host), host.memberToken)).body;
  assert.deepEqual(hostView.members.find(m => m.id === guest.memberId).position.point, [37.4999, 127.0003]);
  assert.equal(hostView.members.find(m => m.id === host.memberId).position.etaSeconds, 360);
});

test('invitation and each member session are scoped; guest cannot close room or publish as host', async t => {
  const f = await fixture(t);
  const host = await f.create();
  const guest = await f.join(host);
  assert.equal((await f.call('join', { roomId: host.roomId, displayName: 'Uninvited' })).status, 401);
  assert.equal((await f.call('join', { roomId: host.roomId, displayName: 'Uninvited' }, guest.memberToken)).status, 401);
  assert.equal((await f.call('snapshot', f.member(host), host.inviteToken)).status, 401);
  assert.equal((await f.call('snapshot', f.member(host), guest.memberToken)).status, 401);
  assert.equal((await f.call('sharing/start', f.member(host), guest.memberToken)).status, 401);
  assert.equal((await f.call('close', f.member(guest), guest.memberToken)).status, 403);
  const other = await f.create('Other room');
  assert.equal((await f.call('snapshot', f.member(other), host.memberToken)).status, 401);
});

test('stop removes position, rejects late publish/replay, and restart requires new epoch', async t => {
  const f = await fixture(t);
  const host = await f.create();
  const guest = await f.join(host);
  const firstEpoch = await f.start(host);
  const publish = (shareEpoch, sequence, point = f.position()) => f.call('position', f.member(host, { shareEpoch, sequence, position: point }), host.memberToken);
  assert.equal((await publish(firstEpoch, 1)).status, 200);
  assert.equal((await publish(firstEpoch, 1)).body.error.code, 'sequence_replayed');
  assert.equal((await f.call('sharing/stop', f.member(host), host.memberToken)).status, 200);
  assert.equal((await publish(firstEpoch, 2)).body.error.code, 'sharing_inactive');
  let snapshot = (await f.call('snapshot', f.member(guest), guest.memberToken)).body;
  assert.equal(snapshot.members[0].sharing, false);
  assert.equal(snapshot.members[0].position, undefined);
  const nextEpoch = await f.start(host);
  assert.notEqual(nextEpoch, firstEpoch);
  assert.equal((await publish(firstEpoch, 10)).status, 409);
  assert.equal((await publish(nextEpoch, 1)).status, 200);
  f.advance(1_000);
  assert.equal((await publish(nextEpoch, 3)).status, 200);
  assert.equal((await publish(nextEpoch, 2)).status, 409);
  assert.equal((await publish(nextEpoch, 4, f.position({ recordedAt: f.now() - 500 }))).body.error.code, 'position_reordered');
});

test('a body delayed across stop cannot resurrect a position', async t => {
  const f = await fixture(t);
  const host = await f.create();
  const epoch = await f.start(host);
  const body = JSON.stringify(f.member(host, { shareEpoch: epoch, sequence: 1, position: f.position() }));
  let req;
  const completed = new Promise((resolve, reject) => {
    req = http.request(f.base + route('position'), { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${host.memberToken}`, 'Content-Length': Buffer.byteLength(body),
    } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.write(body.slice(0, -1));
  });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal((await f.call('sharing/stop', f.member(host), host.memberToken)).status, 200);
  req.end(body.slice(-1));
  const result = await completed;
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'sharing_inactive');
  assert.equal((await f.call('snapshot', f.member(host), host.memberToken)).body.members[0].position, undefined);
});

test('invalid/future/stale timestamps are rejected, stale marked at30s, position and epoch removed at90s', async t => {
  const f = await fixture(t);
  const host = await f.create();
  const epoch = await f.start(host);
  const publish = position => f.call('position', f.member(host, { shareEpoch: epoch, sequence: 1, position }), host.memberToken);
  assert.equal((await publish(f.position({ recordedAt: f.now() - 30_001 }))).body.error.code, 'stale_position');
  assert.equal((await publish(f.position({ recordedAt: f.now() + 5_001 }))).body.error.code, 'future_position');
  assert.equal((await publish(f.position({ recordedAt: 'today' }))).status, 400);
  assert.equal((await publish(f.position({ point: [91, 0] }))).status, 400);
  assert.equal((await publish(f.position({ speedMps: -1 }))).status, 400);
  assert.equal((await publish(f.position({ accuracy: null }))).status, 400);
  assert.equal((await publish(f.position({ etaSeconds: null, speedMps: null }))).status, 200);
  f.advance(30_000);
  let member = (await f.call('snapshot', f.member(host), host.memberToken)).body.members[0];
  assert.equal(member.stale, true);
  assert.ok(member.position);
  f.advance(60_000);
  member = (await f.call('snapshot', f.member(host), host.memberToken)).body.members[0];
  assert.equal(member.position, undefined);
  assert.equal(member.sharing, false);
  assert.equal((await publish(f.position())).body.error.code, 'sharing_inactive');
});

test('staleness respects the client recording age, not just network receipt age', async t => {
  const f = await fixture(t);
  const host = await f.create();
  const epoch = await f.start(host);
  await f.call('position', f.member(host, { shareEpoch: epoch, sequence: 1, position: f.position({ recordedAt: f.now() - 29_000 }) }), host.memberToken);
  f.advance(1_001);
  const member = (await f.call('snapshot', f.member(host), host.memberToken)).body.members[0];
  assert.equal(member.stale, true);
});

test('sharing without a position expires after90s; room expires and cannot be revived', async t => {
  const f = await fixture(t, { roomTtlMs: 120_000 });
  const host = await f.create();
  const guest = await f.join(host);
  await f.start(host);
  f.advance(90_000);
  assert.equal((await f.call('snapshot', f.member(guest), guest.memberToken)).body.members[0].sharing, false);
  f.advance(30_000);
  assert.equal((await f.call('snapshot', f.member(host), host.memberToken)).status, 404);
  assert.equal((await f.call('join', { roomId: host.roomId, displayName: 'Late' }, host.inviteToken)).status, 404);
  assert.equal((await f.call('sharing/start', f.member(guest), guest.memberToken)).status, 404);
});

test('eight-member capacity, guest leave revocation, and host closure are enforced', async t => {
  const f = await fixture(t);
  const host = await f.create();
  const guests = [];
  for (let i = 0; i < 7; i += 1) guests.push(await f.join(host, `Guest ${i}`));
  assert.equal((await f.call('join', { roomId: host.roomId, displayName: 'Overflow' }, host.inviteToken)).body.error.code, 'room_full');
  const guest = guests[0];
  await f.start(guest);
  assert.equal((await f.call('leave', f.member(guest), guest.memberToken)).status, 200);
  assert.equal((await f.call('snapshot', f.member(guest), guest.memberToken)).status, 401);
  await f.join(host, 'Replacement');
  assert.equal((await f.call('close', f.member(host), host.memberToken)).status, 200);
  assert.equal((await f.call('snapshot', f.member(guests[1]), guests[1].memberToken)).status, 404);
  const second = await f.create();
  assert.equal((await f.call('leave', f.member(second), second.memberToken)).body.closed, true);
  assert.equal((await f.call('join', { roomId: second.roomId, displayName: 'Guest' }, second.inviteToken)).status, 404);
});

test('exact CORS, JSON, body, method and URL limits', async t => {
  const f = await fixture(t);
  const createBody = { displayName: 'Host', destination, meetingAt: null };
  assert.equal((await f.call('create', createBody, undefined, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.call('create', createBody, undefined, { headers: { Origin: 'null' } })).status, 403);
  assert.equal((await f.call('create', createBody, undefined, { headers: { Origin: 'http://localhost:3000.evil.example' } })).status, 403);
  let response = await f.call('create', createBody, undefined, { headers: { Origin: 'http://localhost:3000' } });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  response = await f.call('snapshot', undefined, undefined, { method: 'OPTIONS', body: undefined, headers: {
    Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type',
  } });
  assert.equal(response.status, 204);
  assert.equal((await f.call('create', createBody, undefined, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.call('create', {}, undefined, { body: 'not json' })).status, 400);
  assert.equal((await f.call('create', {}, undefined, { body: 'x'.repeat(8_193) })).status, 413);
  assert.equal((await f.call('create?token=must-not-be-in-URL', createBody)).status, 404);
  assert.equal((await f.call('snapshot', {}, undefined, { method: 'GET', body: undefined })).status, 405);
  assert.equal((await f.call('create', { ...createBody, displayName: 'x'.repeat(25) })).status, 400);
});

test('direct HTTP rejects non-local host and untrusted forwarded TLS claims', async t => {
  const f = await fixture(t);
  const body = { displayName: 'Host', destination };
  const rawPost = (base, headers) => new Promise((resolve, reject) => {
    const req = http.request(base + route('create'), { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  assert.equal(await rawPost(f.base, { Host: 'public.example' }), 426);
  assert.equal(await rawPost(f.base, { Host: 'public.example', 'X-Forwarded-Proto': 'https' }), 426);
  const trusted = await fixture(t, { trustedProxyIps: ['127.0.0.1'], allowedOrigins: ['https://walk.example'] });
  assert.equal(await rawPost(trusted.base, { Host: 'api.example', 'X-Forwarded-Proto': 'https', Origin: 'https://walk.example' }), 201);
});

test('bounded request and room creation rates and capacity', async t => {
  const f = await fixture(t, { rateLimits: { createsPerHour: 1 } });
  await f.create();
  assert.equal((await f.call('create', { displayName: 'Second', destination })).status, 429);
  f.advance(3_600_000);
  await f.create('After window');
  const capacity = await fixture(t, { maxRooms: 1 });
  await capacity.create();
  assert.equal((await capacity.call('create', { displayName: 'Second', destination })).status, 503);
  const small = await fixture(t, { rateLimits: { requestsPerMinute: 1 } });
  await small.create();
  assert.equal((await small.call('snapshot')).status, 429);
});

test('configuration rejects wildcard origins, unsafe HTTP origins and excessive retention', () => {
  assert.throws(() => createMeetingServer({ roomTtlMs: MAX_ROOM_TTL_MS + 1 }));
  assert.throws(() => createMeetingServer({ allowedOrigins: ['*'] }));
  assert.throws(() => createMeetingServer({ allowedOrigins: ['https://walk.example/'] }));
  assert.throws(() => createMeetingServer({ allowedOrigins: ['http://walk.example'] }));
  assert.throws(() => createMeetingServer({ trustedProxyIps: ['*'] }));
  assert.deepEqual(configFromEnv({ ALLOWED_ORIGINS: 'https://walk.example,https://other.example', ROOM_TTL_MS: '86400000' }).allowedOrigins,
    ['https://walk.example', 'https://other.example']);
});
