import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {MeetingClient,SharingError,normalizeServerUrl,makeInviteUrl,parseInvite} from '../src/sharing.js';
import {createMeetingServer} from '../server/meeting-server.mjs';

const SERVER = 'https://meeting.example.test';
const ROOM = 'room_0123456789abcdef';
const MEMBER = 'member_0123456789abcdef';
const TOKEN = 'member_secret_0123456789abcdef';
const INVITE = 'invite_secret_0123456789abcdef';
const EPOCH = 'sharing_0123456789abcdef';
const session = () => ({roomId:ROOM,memberId:MEMBER,memberToken:TOKEN});
const details = () => ({displayName:'Alice',destination:{name:'Library',point:[37.5,127]},meetingAt:1_800_000_000_000});
const position = () => ({point:[37.5,127],accuracy:5,speedMps:1.2,etaSeconds:600,recordedAt:1_800_000_000_000});
const response = (data,status=200) => ({ok:status >= 200 && status < 300,status,json:async () => data});
const deferred = () => { let resolve,reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };

function setup(handler = async call => call.path === 'sharing/start' ? {shareEpoch:EPOCH} : {}) {
  const calls = [];
  const client = new MeetingClient(SERVER,{fetchImpl:async (url,options) => {
    const call = {url,options,path:new URL(url).pathname.replace('/api/rooms/',''),body:JSON.parse(options.body)};
    calls.push(call);
    const result = await handler(call,calls.length);
    return result?.json ? result : response(result);
  }});
  return {client,calls};
}

test('server URLs normalize to HTTPS origins without URL credentials or tokens', () => {
  assert.equal(normalizeServerUrl('https://Example.COM:443/'), 'https://example.com');
  assert.equal(normalizeServerUrl('https://meeting.example.test:8443/'), 'https://meeting.example.test:8443');
  for (const value of ['http://meeting.example.test','ftp://meeting.example.test','not-a-url',
    'https://alice:secret@meeting.example.test','https://meeting.example.test/path',
    'https://meeting.example.test/?token=secret','https://meeting.example.test/#invite=secret']) {
    assert.throws(() => normalizeServerUrl(value));
  }
});

test('HTTP localhost is a deliberate development-only exception', () => {
  for (const host of ['localhost','127.0.0.1','[::1]']) {
    assert.throws(() => normalizeServerUrl(`http://${host}:8787`));
    assert.equal(normalizeServerUrl(`http://${host}:8787`,{allowLocalhost:true}),`http://${host}:8787`);
    assert.throws(() => normalizeServerUrl(`https://${host}`));
  }
  assert.throws(() => normalizeServerUrl('http://localhost.evil.test',{allowLocalhost:true}));
  assert.throws(() => normalizeServerUrl('http://192.168.1.10',{allowLocalhost:true}));
});

test('invites round-trip only in the fragment and strip an existing query string', () => {
  const invite = makeInviteUrl('https://walk.example.test/app/?old=secret#old',SERVER,ROOM,INVITE);
  const url = new URL(invite);
  assert.equal(url.pathname,'/app/');
  assert.equal(url.search,'');
  assert.ok(!`${url.origin}${url.pathname}${url.search}`.includes(INVITE));
  assert.deepEqual(parseInvite(invite),{serverUrl:SERVER,roomId:ROOM,inviteToken:INVITE});
  assert.deepEqual(parseInvite(url.hash),{serverUrl:SERVER,roomId:ROOM,inviteToken:INVITE});
});

test('malformed or unsafe invite links cannot establish a server or room', () => {
  const valid = new URL(makeInviteUrl('https://walk.example.test/',SERVER,ROOM,INVITE));
  for (const [key,value] of [['meeting','0'],['room','short'],['invite','../secret'],['server','http://evil.test'],['server','https://alice:secret@evil.test']]) {
    const url = new URL(valid); const params = new URLSearchParams(url.hash.slice(1)); params.set(key,value); url.hash=params.toString();
    assert.throws(() => parseInvite(url.href));
  }
  for (const value of ['','hello','https://walk.example.test/','#meeting=1']) assert.throws(() => parseInvite(value));
  assert.throws(() => makeInviteUrl('https://walk.example.test/',SERVER,'short',INVITE));
  assert.throws(() => makeInviteUrl('https://walk.example.test/',SERVER,ROOM,'bad token with spaces'));
});

test('constructing a room client performs no request, tracking, or sharing', () => {
  const {client,calls} = setup();
  assert.equal(client.session,null);
  assert.equal(client.sharing,false);
  assert.equal(client.shareEpoch,null);
  assert.equal(calls.length,0);
});

test('create and join do not automatically start location sharing', async () => {
  for (const action of ['create','join']) {
    const {client,calls} = setup(async () => session());
    if (action === 'create') await client.create(details());
    else await client.join({roomId:ROOM,inviteToken:INVITE,displayName:'Alice'});
    assert.deepEqual(client.session,session());
    assert.equal(client.sharing,false);
    assert.equal(client.shareEpoch,null);
    assert.equal(await client.publish(position()),false);
    assert.deepEqual(calls.map(call => call.path),[action]);
  }
});

test('every meeting request uses POST and keeps access credentials out of request URLs', async () => {
  const {client,calls} = setup(async call => call.path === 'join' ? session() : call.path === 'sharing/start' ? {shareEpoch:EPOCH} : {});
  await client.join({roomId:ROOM,inviteToken:INVITE,displayName:'Alice'});
  await client.snapshot(); await client.startSharing(); await client.publish(position()); await client.stopSharing(); await client.leave();
  assert.deepEqual(calls.map(call => call.path),['join','snapshot','sharing/start','position','sharing/stop','leave']);
  for (const call of calls) {
    assert.equal(call.options.method,'POST');
    assert.equal(new URL(call.url).search,'');
    assert.equal(new URL(call.url).hash,'');
    for (const secret of [ROOM,MEMBER,TOKEN,INVITE,EPOCH]) assert.ok(!call.url.includes(secret));
    assert.equal(call.options.credentials,'omit');
    assert.equal(call.options.cache,'no-store');
    assert.equal(call.options.redirect,'error');
    assert.equal(call.options.referrerPolicy,'no-referrer');
    assert.equal(call.options.headers['Content-Type'],'application/json');
    assert.equal(call.options.headers.Authorization,`Bearer ${call.path === 'join' ? INVITE : TOKEN}`);
  }
  assert.deepEqual(calls[0].body,{roomId:ROOM,displayName:'Alice'});
  assert.equal(calls[3].body.shareEpoch,EPOCH);
  assert.deepEqual(calls[3].body.position,position());
});

test('room entry rejects malformed session credentials without saving a session', async () => {
  for (const payload of [null,{}, {...session(),roomId:'short'}, {...session(),memberId:null}, {...session(),memberToken:'contains spaces !!!'}]) {
    const {client} = setup(async () => payload);
    await assert.rejects(client.create(details()),/참여 정보/);
    assert.equal(client.session,null);
    assert.equal(client.sharing,false);
  }
});

test('a current room cannot be replaced by another create or join', async () => {
  const {client,calls} = setup(); client.setSession(session());
  await assert.rejects(client.create(details()),/현재 약속방/);
  await assert.rejects(client.join({roomId:ROOM,inviteToken:INVITE}),/현재 약속방/);
  assert.equal(calls.length,0);
});

test('start validates the server sharing epoch before enabling publication', async () => {
  const {client,calls} = setup(async () => ({shareEpoch:'bad'})); client.setSession(session());
  await assert.rejects(client.startSharing(),/공유 세션/);
  assert.equal(client.sharing,false);
  assert.equal(client.shareEpoch,null);
  assert.equal(client.startPending,false);
  assert.equal(await client.publish(position()),false);
  assert.equal(calls.length,1);
});

test('start requires room entry and ignores publication before explicit consent', async () => {
  const {client,calls} = setup();
  await assert.rejects(client.startSharing(),/먼저 들어가/);
  await assert.rejects(client.snapshot(),/먼저 들어가/);
  assert.equal(await client.publish(position()),false);
  assert.equal(calls.length,0);
});

test('publication increments sequence numbers within an explicitly started epoch', async () => {
  const {client,calls} = setup(); client.setSession(session());
  assert.equal(await client.startSharing(),true);
  assert.equal(await client.publish(position()),true);
  assert.equal(await client.publish(position()),true);
  assert.deepEqual(calls.filter(call => call.path === 'position').map(call => call.body.sequence),[1,2]);
  await client.stopSharing(); await client.startSharing(); await client.publish(position());
  assert.equal(calls.at(-1).body.sequence,1);
});

test('stop disables local publication immediately, before the server acknowledges it', async () => {
  const stopped = deferred();
  const {client,calls} = setup(async call => call.path === 'sharing/stop' ? stopped.promise : {shareEpoch:EPOCH});
  client.setSession(session()); await client.startSharing();
  const pending = client.stopSharing({keepalive:true});
  assert.equal(client.sharing,false);
  assert.equal(client.shareEpoch,null);
  assert.equal(await client.publish(position()),false);
  assert.equal(calls.at(-1).options.keepalive,true);
  await assert.rejects(client.startSharing(),/이전 공유 요청/);
  stopped.resolve({}); await pending;
  assert.equal(client.stopping,false);
});

test('a start response arriving after stop cannot silently restart sharing', async () => {
  const started = deferred();
  const {client,calls} = setup(async call => call.path === 'sharing/start' ? started.promise : {});
  client.setSession(session());
  const pending = client.startSharing();
  await assert.rejects(client.startSharing(),/이전 공유 요청/);
  await client.stopSharing();
  started.resolve({shareEpoch:EPOCH});
  assert.equal(await pending,false);
  assert.equal(client.sharing,false);
  assert.equal(client.shareEpoch,null);
  assert.deepEqual(calls.map(call => call.path),['sharing/start','sharing/stop','sharing/stop']);
});

test('a publication acknowledgement arriving after stop stays cancelled locally', async () => {
  const published = deferred();
  const {client} = setup(async call => call.path === 'position' ? published.promise : call.path === 'sharing/start' ? {shareEpoch:EPOCH} : {});
  client.setSession(session()); await client.startSharing();
  const pending = client.publish(position()); await client.stopSharing();
  published.resolve({});
  assert.equal(await pending,false);
  assert.equal(client.sharing,false);
});

test('expired/revoked/missing server sessions stop publication, but a temporary server error does not', async () => {
  for (const status of [401,403,404,409,410,503]) {
    const {client} = setup(async call => call.path === 'position' ? response({error:{code:'FAILED',message:'Request failed'}},status) : {shareEpoch:EPOCH});
    client.setSession(session()); await client.startSharing();
    await assert.rejects(client.publish(position()),error => error instanceof SharingError && error.status === status);
    assert.equal(client.sharing,status === 503);
    assert.equal(client.shareEpoch,status === 503 ? EPOCH : null);
  }
});

test('an old publication failure does not cancel a newly started sharing epoch', async () => {
  const published = deferred();
  const {client} = setup(async call => call.path === 'position' ? published.promise : call.path === 'sharing/start' ? {shareEpoch:EPOCH} : {});
  client.setSession(session()); await client.startSharing();
  const pending = client.publish(position()); await client.stopSharing(); await client.startSharing();
  published.resolve(response({error:{message:'Old epoch'}},409));
  await assert.rejects(pending,SharingError);
  assert.equal(client.sharing,true);
});

test('leave clears session and tracking state before waiting for the server', async () => {
  const left = deferred();
  const {client,calls} = setup(async call => call.path === 'leave' ? left.promise : {shareEpoch:EPOCH});
  client.setSession(session()); await client.startSharing();
  const pending = client.leave();
  assert.equal(client.session,null); assert.equal(client.sharing,false); assert.equal(client.shareEpoch,null);
  assert.equal(calls.at(-1).options.keepalive,true);
  left.resolve({}); await pending;
});

test('closing a room uses the close endpoint with the current member authorization', async () => {
  const {client,calls} = setup(); client.setSession(session());
  await client.leave({closeRoom:true});
  assert.equal(calls[0].path,'close'); assert.deepEqual(calls[0].body,{roomId:ROOM,memberId:MEMBER});
  assert.equal(client.session,null);
});

test('late sharing-start response after leaving is compensated without restoring the room', async () => {
  const started = deferred();
  const {client,calls} = setup(async call => call.path === 'sharing/start' ? started.promise : {});
  client.setSession(session()); const pending = client.startSharing(); await client.leave();
  started.resolve({shareEpoch:EPOCH});
  assert.equal(await pending,false); assert.equal(client.session,null); assert.equal(client.sharing,false);
  assert.equal(calls.at(-1).path,'sharing/stop');
});

test('server error status, code, and message remain available to the UI', async () => {
  const {client} = setup(async () => response({error:{code:'EXPIRED',message:'Room expired'}},410));
  await assert.rejects(client.create(details()),error => error instanceof SharingError && error.status === 410 && error.code === 'EXPIRED' && error.message === 'Room expired');
  assert.equal(client.session,null);
});

test('malformed JSON reports a sharing error without establishing session or consent', async () => {
  const client = new MeetingClient(SERVER,{fetchImpl:async () => ({ok:true,status:200,json:async () => {throw new SyntaxError('Bad JSON');}})});
  await assert.rejects(client.create(details()),error => error instanceof SharingError && /응답/.test(error.message));
  assert.equal(client.session,null); assert.equal(client.sharing,false);
});

test('network errors do not leave the start-pending flag permanently locked', async () => {
  const {client} = setup(async () => {throw new TypeError('Network failed');}); client.setSession(session());
  await assert.rejects(client.startSharing(),/Network failed/);
  assert.equal(client.startPending,false); assert.equal(client.sharing,false);
});

test('stale create/join response after leaving cannot re-enter a cancelled room', async () => {
  for (const action of ['create','join']) {
    const entered = deferred(); const {client,calls} = setup(async call => call.path === action ? entered.promise : {});
    const pending = action === 'create' ? client.create(details()) : client.join({roomId:ROOM,inviteToken:INVITE,displayName:'Alice'});
    await client.leave(); entered.resolve(session());
    await pending.catch(() => {});
    assert.equal(client.session,null,`${action} must stay cancelled after leaving`);
    assert.equal(client.sharing,false);
    assert.deepEqual(calls.map(call => call.path),[action,'leave']);
    assert.equal(calls.at(-1).options.keepalive,true);
    assert.equal(calls.at(-1).options.headers.Authorization,`Bearer ${TOKEN}`);
  }
});

test('concurrent create/join requests are rejected until the first entry resolves', async () => {
  const entered = deferred(); const {client,calls} = setup(async () => entered.promise);
  const pending = client.create(details());
  await assert.rejects(client.create(details()),/참여 요청/);
  await assert.rejects(client.join({roomId:ROOM,inviteToken:INVITE,displayName:'Alice'}),/참여 요청/);
  assert.equal(calls.length,1);
  entered.resolve(session()); await pending;
  assert.equal(client.entryPending,false);
});

test('failed room entry releases its pending guard so another attempt can proceed', async () => {
  const {client} = setup(async () => {throw new Error('Offline');});
  await assert.rejects(client.create(details()),/Offline/);
  assert.equal(client.entryPending,false);
  assert.equal(client.session,null);
  await assert.rejects(client.create(details()),/Offline/);
});

test('overlapping stops cannot permit a new start while an old stop is pending', async () => {
  const stops = [deferred(),deferred()]; let stopCount = 0;
  const {client} = setup(async call => call.path === 'sharing/stop' ? stops[stopCount++].promise : {shareEpoch:EPOCH});
  client.setSession(session()); await client.startSharing();
  const first = client.stopSharing(); const second = client.stopSharing();
  stops[0].resolve({}); await first;
  try { await assert.rejects(client.startSharing(),/이전 공유 요청/); }
  finally { stops[1].resolve({}); await second; }
  assert.equal(client.stopping,false);
  assert.equal(client.stopRequests,0);
});

test('overlapping stop failures keep the guard until every pending stop settles', async () => {
  const stops = [deferred(),deferred()]; let stopCount = 0;
  const {client} = setup(async call => call.path === 'sharing/stop' ? stops[stopCount++].promise : {shareEpoch:EPOCH});
  client.setSession(session()); await client.startSharing();
  const first = client.stopSharing(); const second = client.stopSharing();
  stops[0].reject(new Error('First stop failed')); await assert.rejects(first,/First stop failed/);
  assert.equal(client.stopping,true);
  await assert.rejects(client.startSharing(),/이전 공유 요청/);
  stops[1].resolve({}); await second;
  assert.equal(client.stopping,false);
  assert.equal(client.sharing,false);
});

test('two MeetingClients work end-to-end with the local server and never auto-share', async t => {
  const now = 1_800_000_000_000;
  const server = createMeetingServer({now:() => now});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  const url = `http://127.0.0.1:${server.address().port}`;
  const host = new MeetingClient(url,{allowLocalhost:true});
  const guest = new MeetingClient(url,{allowLocalhost:true});
  const created = await host.create(details());
  const invite = parseInvite(makeInviteUrl('http://localhost:3000/',url,created.roomId,created.inviteToken),{allowLocalhost:true});
  await guest.join({...invite,displayName:'Bob'});
  let snapshot = await guest.snapshot();
  assert.equal(snapshot.members.length,2);
  assert.ok(snapshot.members.every(member => !member.sharing && !member.position));
  assert.equal(await host.publish(position()),false);
  await host.startSharing(); assert.equal(await host.publish(position()),true);
  snapshot = await guest.snapshot();
  const visible = snapshot.members.find(member => member.id === host.session.memberId);
  assert.deepEqual(visible.position.point,[37.5,127]);
  assert.equal(visible.position.recordedAt,now);
  assert.equal(visible.position.receivedAt,now);
  assert.equal(visible.position.speedMps,1.2);
  assert.equal(visible.position.etaSeconds,600);
  assert.equal(guest.sharing,false);
  await host.stopSharing();
  snapshot = await guest.snapshot();
  assert.ok(snapshot.members.every(member => !member.position));
  await host.leave({closeRoom:true});
  await assert.rejects(guest.snapshot(),error => error instanceof SharingError && error.status === 404);
});
