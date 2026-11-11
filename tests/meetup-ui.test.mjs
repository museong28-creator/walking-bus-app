import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setImmediate as flush} from 'node:timers/promises';
import vm from 'node:vm';
import * as meeting from '../src/meeting.js';
import * as sharing from '../src/sharing.js';
import {isCoordinate,distance} from '../src/core.js';

const source = (await readFile(new URL('../src/meetup-ui.js',import.meta.url),'utf8'))
  .replace(/^import .*;\n/gm,'').replace('export function initMeetupUI','function initMeetupUI')
  + '\nglobalThis.initialize = initMeetupUI;';
const ROOM = 'room_0123456789abcdef', SELF = 'self_0123456789abcdef', FRIEND = 'friend_0123456789abcdef';
const TOKEN = 'token_0123456789abcdef', INVITE = 'invite_0123456789abcdef', EPOCH = 'epoch_0123456789abcdef';
const SERVER = 'https://meeting.example.test';
const INITIAL = 1_800_000_000_000;
const destination = () => ({name:'Synthetic library',point:[37.5,127]});
const deferred = () => {let resolve,reject;const promise = new Promise((a,b) => {resolve=a;reject=b;});return {promise,resolve,reject};};

class Target {
  constructor() {this.listeners = new Map();}
  addEventListener(type,handler) {this.listeners.set(type,[...(this.listeners.get(type) || []),handler]);}
  async emit(type,details={}) {await Promise.all((this.listeners.get(type) || []).map(handler => handler({preventDefault() {},...details})));}
}
class Element extends Target {
  constructor(tagName='div') {
    super();this.tagName=tagName;this.textContent='';this.value='';this.children=[];this.disabled=false;this.open=false;this.className='';
    const classes=new Set();this.classList={add:value=>classes.add(value),remove:value=>classes.delete(value),contains:value=>classes.has(value),toggle(value,force){const enabled=force ?? !classes.has(value);if(enabled)classes.add(value);else classes.delete(value);return enabled;}};
  }
  append(...children) {this.children.push(...children);}
  replaceChildren(...children) {this.children=children;}
  closest() {this.container ??= new Element('details');return this.container;}
}
const textIn = element => [element.textContent,...element.children.map(textIn)].join(' ');

function harness(options={}) {
  let now=INITIAL, gpsRequests=0, shownMaps=0;
  const elements=new Map(), calls=[], consents=[], notices=[], selected=[], clients=[], copied=[], historyCalls=[];
  const $=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  $('friend-name').value='Alice';$('sharing-server').value=SERVER;$('arrival-buffer').value='120';$('comfort-speed').value='4.3';
  const context={demo:false,tracking:false,destination:destination(),position:null,lastGoodFix:0,fix:null,
    estimate:{progress:{remaining:600},stale:false,unreliable:false,offRoute:false,arrived:false,speed:1.2,seconds:500}};
  const roomData={roomId:ROOM,hostMemberId:SELF,destination:destination(),meetingAt:null,serverTime:now,expiresAt:now+3_600_000,
    members:[{id:SELF,name:'Alice',sharing:false},{id:FRIEND,name:'Bob',sharing:false}]};
  const document=Object.assign(new Target(),{visibilityState:'visible',getElementById:$,createElement:tag=>new Element(tag)});
  const window=new Target(), location=new URL(options.url || 'https://walk.example.test/app/');
  const layers=[];
  const map={bounds:[],fitBounds(points,settings){this.bounds.push({points,settings});}};
  const L={layerGroup(){const layer={markers:[],addTo(){layers.push(this);return this;},clearLayers(){this.markers=[];}};return layer;},
    divIcon:options=>options,latLngBounds:value=>value,
    marker(point,options){return {point,options,bindPopup(popup){this.popup=popup;return this;},addTo(layer){layer.markers.push(this);return this;}};}};
  const fetchImpl=async (url,init)=>{
    const call={url,init,path:new URL(url).pathname.replace('/api/rooms/',''),body:JSON.parse(init.body)};calls.push(call);
    let data;
    if(options.onRequest) data=await options.onRequest(call,{roomData,context,now});
    if(data === undefined) {
      if(['create','join'].includes(call.path)) data={roomId:ROOM,memberId:SELF,memberToken:TOKEN,inviteToken:INVITE};
      else if(call.path==='snapshot') data={...structuredClone(roomData),serverTime:now};
      else if(call.path==='sharing/start') data={shareEpoch:EPOCH};
      else data={};
    }
    if(data?.json)return data;
    return {ok:true,status:200,json:async()=>data};
  };
  class Client extends sharing.MeetingClient {constructor(url,settings){super(url,{...settings,fetchImpl});clients.push(this);}}
  class ClockDate extends Date {static now(){return now;}}
  const realm=vm.createContext({...meeting,...sharing,MeetingClient:Client,isCoordinate,distance,Date:ClockDate,Intl,
    document,window,location,L,history:{replaceState(...args){historyCalls.push(args);}},
    navigator:{clipboard:{writeText:async text=>{copied.push(text);}}},console});
  vm.runInContext(source,realm,{filename:'src/meetup-ui.js'});
  const api=realm.initialize({map,askConsent:async (...args)=>{consents.push(args);return options.consent ? options.consent(...args) : true;},
    notice:message=>notices.push(message),formatTime:timestamp=>new Date(timestamp).toISOString(),getContext:()=>({...context,estimate:{...context.estimate}}),
    requestGps:()=>{gpsRequests++;},selectDestination:(point,name)=>{selected.push({point,name});context.destination={point,name};},showSharedMap:()=>{shownMaps++;}});
  return {api,$,calls,consents,notices,context,roomData,clients,layers,map,document,window,selected,copied,historyCalls,
    get now(){return now;},get gpsRequests(){return gpsRequests;},get shownMaps(){return shownMaps;},
    advance(ms){now+=ms;},async click(id){await $(id).emit('click');await flush();},async refresh(){api.refresh();await flush();},
    fix(){context.tracking=true;context.lastGoodFix=now;context.position=[37.5001,127.0001];context.fix={accuracy:5};},
    setTarget(secondsFromNow){$('target-time').value=new Date(now+secondsFromNow*1000).toISOString();},
  };
}

async function joined(options={}) {const h=harness(options);await h.click('create-room');return h;}
function sharedFriend(h,overrides={}) {
  h.roomData.members[1]={id:FRIEND,name:'Bob',sharing:true,position:{point:[37.501,127.001],accuracy:5,speedMps:1.2,etaSeconds:600,recordedAt:h.now,receivedAt:h.now},...overrides};
}

test('UI initialization and invite opening do not contact a server or request GPS', async () => {
  for(const url of [undefined,sharing.makeInviteUrl('https://walk.example.test/app/',SERVER,ROOM,INVITE)]) {
    const h=harness({url});await h.refresh();
    assert.equal(h.calls.length,0);assert.equal(h.gpsRequests,0);assert.equal(h.consents.length,0);assert.equal(h.layers[0].markers.length,0);
    if(url){assert.equal(h.$('invite-input').value,url);assert.equal(h.$('invite-input').closest('details').open,true);assert.match(h.notices.at(-1),/아직 연결하거나 위치를 공유하지/);}
  }
});

test('malformed invitations stay offline with a visible error', () => {
  const h=harness({url:'https://walk.example.test/#meeting=1&room=bad&invite=bad'});
  assert.equal(h.calls.length,0);assert.equal(h.clients.length,0);assert.equal(h.gpsRequests,0);assert.match(h.notices.at(-1),/올바른 약속 초대/);
});

test('declining room consent transmits neither the destination nor display name', async () => {
  const h=harness({consent:()=>false});await h.click('create-room');
  assert.equal(h.consents.length,1);assert.equal(h.calls.length,0);assert.equal(h.gpsRequests,0);assert.equal(h.clients[0].session,null);
});

test('creating or joining a room does not automatically share or request GPS', async () => {
  for(const joining of [false,true]) {
    const h=harness();
    if(joining)h.$('invite-input').value=sharing.makeInviteUrl('https://walk.example.test/app/',SERVER,ROOM,INVITE);
    await h.click(joining?'join-room':'create-room');
    assert.deepEqual(h.calls.map(call=>call.path),[joining?'join':'create','snapshot']);
    assert.equal(h.clients[0].sharing,false);assert.equal(h.gpsRequests,0);assert.equal(h.selected.length,1);
    assert.match(h.$('sharing-status').textContent,/내 위치는 공유하지 않아요/);
    assert.equal(h.$('room-active').classList.contains('hidden'),false);
  }
});

test('invalid name, missing destination, virtual demo, and unsafe server prevent creation', async () => {
  for(const modify of [h=>{h.$('friend-name').value='';},h=>{h.$('friend-name').value='x'.repeat(25);},h=>{h.context.destination=null;},h=>{h.context.demo=true;},h=>{h.$('sharing-server').value='http://external.example.test';}]) {
    const h=harness();modify(h);await h.click('create-room');assert.equal(h.calls.length,0);assert.equal(h.gpsRequests,0);assert.ok(h.notices.at(-1));
  }
});

test('declining explicit sharing consent leaves the room connected without tracking', async () => {
  const h=await joined({consent:title=>!title.includes('내 위치')});await h.click('share-location');
  assert.deepEqual(h.calls.map(call=>call.path),['create','snapshot']);assert.equal(h.gpsRequests,0);assert.equal(h.clients[0].sharing,false);
});

test('explicit sharing starts a server epoch and requests GPS only when not tracking', async () => {
  for(const tracking of [false,true]) {
    const h=await joined();h.context.tracking=tracking;await h.click('share-location');
    assert.equal(h.calls.at(-1).path,'sharing/start');assert.equal(h.clients[0].sharing,true);
    assert.equal(h.gpsRequests,tracking?0:1);assert.equal(h.calls.some(call=>call.path==='position'),false);
    assert.match(h.consents.at(-1)[1],/정확한 GPS 위치/);assert.match(h.consents.at(-1)[1],/모든 참가자/);
  }
});

test('only fresh real GPS fixes publish, and the same fix is not sent twice', async () => {
  const h=await joined();await h.click('share-location');await h.refresh();assert.equal(h.calls.some(call=>call.path==='position'),false);
  h.fix();await h.refresh();
  let sent=h.calls.filter(call=>call.path==='position');assert.equal(sent.length,1);
  assert.deepEqual(sent[0].body.position,{point:[37.5001,127.0001],accuracy:5,speedMps:1.2,etaSeconds:500,recordedAt:h.now});
  h.advance(6000);await h.refresh();assert.equal(h.calls.filter(call=>call.path==='position').length,1);
  h.fix();await h.refresh();assert.equal(h.calls.filter(call=>call.path==='position').length,2);
});

test('demo, stale, inaccurate, and stopped tracking states never publish positions', async () => {
  for(const modify of [h=>{h.context.demo=true;},h=>{h.context.estimate.stale=true;},h=>{h.context.estimate.unreliable=true;},h=>{h.context.tracking=false;},h=>{h.context.fix=null;}]) {
    const h=await joined();await h.click('share-location');h.fix();modify(h);await h.refresh();
    assert.equal(h.calls.filter(call=>call.path==='position').length,0);
  }
});

test('sharing cannot be started from the virtual demo', async () => {
  const h=await joined();h.context.demo=true;await h.click('share-location');
  assert.equal(h.calls.some(call=>call.path==='sharing/start'),false);assert.equal(h.gpsRequests,0);assert.match(h.notices.at(-1),/가상 위치/);
});

test('explicit stop prevents new publication immediately and requests server deletion', async () => {
  const stopped=deferred();const h=await joined({onRequest:call=>call.path==='sharing/stop'?stopped.promise:undefined});
  await h.click('share-location');h.fix();
  const pending=h.$('stop-sharing').emit('click');await flush();
  assert.equal(h.clients[0].sharing,false);assert.equal(h.calls.at(-1).path,'sharing/stop');assert.equal(h.calls.at(-1).init.keepalive,true);
  await h.refresh();assert.equal(h.calls.some(call=>call.path==='position'),false);
  stopped.resolve({});await pending;await flush();assert.match(h.$('sharing-status').textContent,/삭제를 확인/);
});

test('backgrounding and page exit stop sharing without silently restarting on return', async () => {
  for(const event of ['visibilitychange','pagehide']) {
    const h=await joined();await h.click('share-location');h.fix();
    if(event==='visibilitychange'){h.document.visibilityState='hidden';await h.document.emit(event);}else await h.window.emit(event);
    await flush();assert.equal(h.clients[0].sharing,false);assert.ok(h.calls.some(call=>call.path==='sharing/stop'));
    h.document.visibilityState='visible';h.advance(6000);await h.refresh();
    assert.equal(h.calls.filter(call=>call.path==='sharing/start').length,1);assert.equal(h.calls.some(call=>call.path==='position'),false);
  }
});

test('changing away from the meeting destination pauses sharing', async () => {
  const h=await joined();await h.click('share-location');h.fix();h.api.destinationChanged([38,128]);await flush();
  assert.equal(h.clients[0].sharing,false);assert.ok(h.calls.some(call=>call.path==='sharing/stop'));
  assert.match(h.$('sharing-status').textContent,/다른 목적지/);
});

test('refresh also catches a mismatched destination before transmitting a position', async () => {
  const h=await joined();await h.click('share-location');h.fix();h.context.destination={name:'Other',point:[38,128]};await h.refresh();
  assert.equal(h.calls.some(call=>call.path==='position'),false);assert.equal(h.clients[0].sharing,false);
});

test('participant map markers require a real shared position, never membership alone', async () => {
  const h=await joined();assert.equal(h.layers[0].markers.length,0);
  sharedFriend(h);h.advance(5000);await h.refresh();
  assert.equal(h.layers[0].markers.length,1);assert.deepEqual(h.layers[0].markers[0].point,[37.501,127.001]);
  assert.match(h.layers[0].markers[0].options.alt,/Bob/);assert.match(textIn(h.$('friends-list')),/ETA 약 10분/);
});

test('participant markers become stale at 30 seconds and disappear at 90 seconds', async () => {
  const h=await joined();sharedFriend(h);h.advance(5000);await h.refresh();assert.equal(h.layers[0].markers.length,1);
  h.advance(25_000);await h.refresh();assert.match(h.layers[0].markers[0].options.icon.className,/friend-stale/);assert.match(textIn(h.$('friends-list')),/오래된 위치/);
  h.advance(60_000);await h.refresh();assert.equal(h.layers[0].markers.length,0);assert.match(textIn(h.$('friends-list')),/새 위치를 기다리고/);
});

test('unshared, invalid, or already stale-hidden participant coordinates never create a marker', async () => {
  for(const modify of [h=>{sharedFriend(h,{sharing:false});},h=>{sharedFriend(h);h.roomData.members[1].position.point=[91,0];},h=>{sharedFriend(h);h.roomData.members[1].position.recordedAt-=90_000;},h=>{sharedFriend(h);delete h.roomData.members[1].position.receivedAt;}]) {
    const h=await joined();modify(h);h.advance(5000);await h.refresh();assert.equal(h.layers[0].markers.length,0);
  }
});

test('virtual demo suppresses real friend markers and map fitting', async () => {
  const h=await joined();sharedFriend(h);h.advance(5000);await h.refresh();assert.equal(h.layers[0].markers.length,1);
  h.context.demo=true;await h.refresh();assert.equal(h.layers[0].markers.length,0);await h.click('fit-friends');assert.equal(h.map.bounds.length,0);
  h.context.demo=false;await h.refresh();await h.click('fit-friends');assert.equal(h.map.bounds.length,1);assert.equal(h.map.bounds[0].points.length,2);
});

test('unsafe required pace is hidden and replaced with a non-coercive warning', async () => {
  const h=harness();h.setTarget(300);await h.$('deadline-form').emit('submit');
  assert.match(h.$('deadline-headline').textContent,/편한 걸음으로는 여유가 부족/);
  assert.match(h.$('deadline-detail').textContent,/무리하지 말고 약속 시간을 조정/);
  assert.match(h.$('deadline-pace').textContent,/더 빠르게 걷도록 권하지/);
  assert.doesNotMatch(h.$('deadline-pace').textContent,/km\/h|초\/km/);
});

test('safe pace includes units; stale/off-route or missing route hides the speed calculation', async () => {
  const h=harness();h.setTarget(900);await h.$('deadline-form').emit('submit');assert.match(h.$('deadline-pace').textContent,/km\/h.*초\/km/);
  for(const state of [{stale:true},{stale:false,offRoute:true},{offRoute:false,progress:null}]) {
    Object.assign(h.context.estimate,state);await h.refresh();assert.doesNotMatch(h.$('deadline-pace').textContent,/km\/h/);assert.match(h.$('deadline-detail').textContent,/실제 도보 경로/);
  }
  await h.click('clear-deadline');assert.equal(h.$('deadline-result').classList.contains('hidden'),true);
});

test('room mismatch and untrusted destination coordinates never get selected or start sharing', async () => {
  for(const modify of [data=>({...data,roomId:'different_room_123456789'}),data=>({...data,destination:{name:'Invalid',point:[91,0]}}),data=>({...data,destination:{name:{html:'bad'},point:[37.5,127]}})]) {
    const h=await joined({onRequest:(call,{roomData,now})=>call.path==='snapshot'?modify({...structuredClone(roomData),serverTime:now}):undefined});
    assert.equal(h.selected.length,0);assert.equal(h.layers[0].markers.length,0);await h.click('share-location');assert.equal(h.calls.some(call=>call.path==='sharing/start'),false);
  }
});

test('server names are inserted as text rather than interpreted as HTML', async () => {
  const payload='<img src=x onerror=alert(1)>';
  const h=await joined({onRequest:(call,{roomData,now})=>call.path==='snapshot'?{...structuredClone(roomData),serverTime:now,destination:{name:payload,point:[37.5,127]},members:[{id:SELF,name:payload,sharing:false}]}:undefined});
  assert.equal(h.$('room-destination').textContent,payload);assert.equal(h.$('room-destination').children.length,0);
  assert.match(textIn(h.$('friends-list')),/onerror=alert/);assert.equal(h.layers[0].markers.length,0);
});

test('room expiry removes markers and disables sharing before any more positions publish', async () => {
  let expired=false;
  const h=await joined({onRequest:call=>expired&&call.path==='snapshot'?{ok:false,status:404,json:async()=>({error:{message:'Room expired'}})}:undefined});
  await h.click('share-location');sharedFriend(h);h.advance(5000);await h.refresh();assert.equal(h.layers[0].markers.length,1);
  expired=true;h.advance(5000);await h.refresh();assert.equal(h.clients[0].session,null);assert.equal(h.clients[0].sharing,false);assert.equal(h.layers[0].markers.length,0);
  h.fix();await h.refresh();assert.equal(h.calls.some(call=>call.path==='position'),false);
});

test('an in-flight snapshot cannot restore markers after leaving the room', async () => {
  const snapshot=deferred();let delayed=false;
  const h=await joined({onRequest:call=>delayed&&call.path==='snapshot'?snapshot.promise:undefined});
  sharedFriend(h);delayed=true;h.advance(5000);h.api.refresh();await flush();
  await h.click('leave-room');snapshot.resolve({...structuredClone(h.roomData),serverTime:h.now});await flush();
  assert.equal(h.layers[0].markers.length,0);assert.equal(h.$('friends-list').children.length,0);assert.equal(h.$('room-active').classList.contains('hidden'),true);
});

test('copying an invite only writes the clipboard and never sends it to a friend', async () => {
  const h=await joined();const count=h.calls.length;await h.click('copy-invite');
  assert.equal(h.calls.length,count);assert.equal(h.copied.length,1);assert.deepEqual(sharing.parseInvite(h.copied[0]),{serverUrl:SERVER,roomId:ROOM,inviteToken:INVITE});
});

test('stopping while sharing-start is pending prevents GPS and compensates the late start', async () => {
  const started=deferred();
  const h=await joined({onRequest:call=>call.path==='sharing/start'?started.promise:undefined});
  const pending=h.$('share-location').emit('click');await flush();
  assert.equal(h.clients[0].startPending,true);
  await h.api.pauseSharing();started.resolve({shareEpoch:EPOCH});await pending;await flush();
  assert.equal(h.clients[0].sharing,false);assert.equal(h.gpsRequests,0);
  assert.equal(h.calls.filter(call=>call.path==='sharing/stop').length,2);
});

test('backgrounding while sharing consent is pending prevents subsequent sharing', async () => {
  const consent=deferred();
  const h=await joined({consent:title=>title.includes('내 위치')?consent.promise:true});
  const pending=h.$('share-location').emit('click');await flush();
  h.document.visibilityState='hidden';await h.document.emit('visibilitychange');
  consent.resolve(true);await pending;await flush();
  assert.equal(h.calls.some(call=>call.path==='sharing/start'),false);assert.equal(h.gpsRequests,0);
});

test('page exit cancels pending room entry and cleans up the late created room', async () => {
  const created=deferred();const h=harness({onRequest:call=>call.path==='create'?created.promise:undefined});
  const pending=h.$('create-room').emit('click');await flush();
  assert.equal(h.clients[0].entryPending,true);await h.window.emit('pagehide');
  created.resolve({roomId:ROOM,memberId:SELF,memberToken:TOKEN,inviteToken:INVITE});await pending;await flush();
  assert.deepEqual(h.calls.map(call=>call.path),['create','leave']);assert.equal(h.clients[0].session,null);assert.equal(h.selected.length,0);assert.equal(h.gpsRequests,0);
});

test('a failed stop still blocks new positions and honestly reports unconfirmed server deletion', async () => {
  const h=await joined({onRequest:call=>{if(call.path==='sharing/stop')throw new Error('Offline');}});
  await h.click('share-location');h.fix();await h.click('stop-sharing');await h.refresh();
  assert.equal(h.clients[0].sharing,false);assert.equal(h.calls.some(call=>call.path==='position'),false);
  assert.match(h.$('sharing-status').textContent,/서버 삭제는 확인하지 못/);assert.match(h.$('sharing-status').textContent,/90초/);
});

test('failed publication pauses sharing rather than continually resending', async () => {
  const h=await joined({onRequest:call=>{if(call.path==='position')throw new Error('Connection lost');}});
  await h.click('share-location');h.fix();await h.refresh();await flush();
  assert.equal(h.clients[0].sharing,false);assert.ok(h.calls.some(call=>call.path==='sharing/stop'));
  h.advance(6000);h.fix();await h.refresh();assert.equal(h.calls.filter(call=>call.path==='position').length,1);
  assert.match(h.$('sharing-status').textContent,/다시 공유 시작/);
});

test('UI permits only one publication in flight even if newer fixes arrive', async () => {
  const published=deferred();const h=await joined({onRequest:call=>call.path==='position'?published.promise:undefined});
  await h.click('share-location');h.fix();h.api.refresh();await flush();
  h.advance(6000);h.fix();await h.refresh();assert.equal(h.calls.filter(call=>call.path==='position').length,1);
  published.resolve({});await flush();await h.refresh();assert.equal(h.calls.filter(call=>call.path==='position').length,2);
});

test('self positions are listed but never duplicated as friend markers', async () => {
  const h=await joined();h.roomData.members[0]={id:SELF,name:'Alice',sharing:true,position:{point:[37.5001,127.0001],accuracy:5,etaSeconds:500,receivedAt:h.now,recordedAt:h.now}};
  h.advance(5000);await h.refresh();assert.equal(h.layers[0].markers.length,0);assert.match(textIn(h.$('friends-list')),/Alice \(나\).*ETA 약 9분/);
});

test('offline polling does not prevent aging existing friend positions out of view', async () => {
  let offline=false;
  const h=await joined({onRequest:call=>{if(offline&&call.path==='snapshot')throw new Error('Offline');}});
  sharedFriend(h);h.advance(5000);await h.refresh();assert.equal(h.layers[0].markers.length,1);
  offline=true;h.advance(85_000);await h.refresh();assert.equal(h.layers[0].markers.length,0);assert.match(h.$('sharing-status').textContent,/연결이 지연/);
});

test('manual bus time uses the exact absolute arrival timestamp and a one-minute safety buffer', async () => {
  const h=harness();const arrival=h.now+721_234;
  h.api.useBusTime(arrival);
  assert.equal(h.$('target-time').value,meeting.localDateTimeValue(arrival));
  assert.equal(h.$('arrival-buffer').value,'60');
  assert.match(h.$('deadline-detail').textContent,/1분 먼저 도착/);
  assert.ok(h.$('deadline-detail').textContent.includes(new Date(arrival).toISOString()),'the calculation keeps seconds even though datetime-local shows minutes');
  assert.equal(h.$('deadline-result').classList.contains('hidden'),false);
  h.advance(60_000);await h.refresh();
  assert.ok(h.$('deadline-detail').textContent.includes(new Date(arrival).toISOString()));
  assert.equal(h.calls.length,0,'using a manual bus time does not request live transit data');
});
