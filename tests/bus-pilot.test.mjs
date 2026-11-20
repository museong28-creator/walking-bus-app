import test from 'node:test';
import assert from 'node:assert/strict';
import {PILOT_STOP,pilotComparison,initBusPilot} from '../src/bus-pilot.js';
const now=1700000000000;
const payload=()=>({provider:'TAGO',status:'estimated',fetchedAt:new Date(now).toISOString(),expiresAt:new Date(now+30000).toISOString(),arrivals:[{routeId:PILOT_STOP.routeId,etaSeconds:215,remainingStops:4},{routeId:'OTHER',etaSeconds:1},{routeId:PILOT_STOP.routeId,etaSeconds:522,remainingStops:11}]});
const context=()=>({destination:{point:[...PILOT_STOP.point]},route:{},estimate:{seconds:180,speed:1.2,progress:{remaining:216}},speedOrigin:'calibrated'});
test('official route only, elapsed time deducted, direction never inferred from ETA',()=>{
 const v=pilotComparison(payload(),context(),now+15000);
 assert.deepEqual(v.arrivals.map(a=>a.seconds),[200,507]);assert.equal(v.walkSeconds,180);assert.equal(v.directionVerified,false);
 assert.equal(pilotComparison(payload(),context(),now+30000).arrivals.length,0);
});
test('walking comparison rejects other destinations, missing route, demo and unreliable GPS',()=>{
 for(const c of [{...context(),destination:{point:[37,127]}},{...context(),route:null},{...context(),demo:true},{...context(),estimate:{seconds:null}}])assert.equal(pilotComparison(payload(),c,now).walkSeconds,null);
});
function harness(navigation){
 const elements=new Map(),listeners=new Map();let subscriber;
 const element=id=>{if(!elements.has(id))elements.set(id,{textContent:'',addEventListener:(type,fn)=>listeners.set(`${id}:${type}`,fn)});return elements.get(id);};
 const doc={visibilityState:'visible',getElementById:element,addEventListener:(type,fn)=>listeners.set(`doc:${type}`,fn)};
 const session={user:{uid:'owner'},subscribe(fn){subscriber=fn;fn();}};
 const ui=initBusPilot({document:doc,window:{addEventListener(){}},session,getContext:context,showStop(){},selectStop(){},navigation,now:()=>now});
 return {element,doc,ui,click:()=>listeners.get('pilot-refresh:click')(),logout(){session.user=null;subscriber();},hide(){doc.visibilityState='hidden';listeners.get('doc:visibilitychange')();}};
}
test('late response after logout cannot restore arrival data',async()=>{
 let resolve;const h=harness({arrivals:()=>new Promise(r=>resolve=r)});const request=h.click();h.logout();resolve(payload());await request;
 assert.equal(h.element('pilot-arrival').textContent,'—');assert.match(h.element('pilot-status').textContent,/로그인/);
});
test('hidden page cancels pending response and requires manual refresh',async()=>{
 let resolve,signal;const h=harness({arrivals:(city,stop,s)=>{assert.equal(city,'22');assert.equal(stop,PILOT_STOP.id);signal=s;return new Promise(r=>resolve=r);}});
 const request=h.click();h.hide();assert.equal(signal.aborted,true);resolve(payload());await request;assert.equal(h.element('pilot-arrival').textContent,'—');
});
test('quota error stays explicit and never starts an automatic request',async()=>{
 let calls=0;const h=harness({arrivals:async()=>{calls++;throw Object.assign(new Error(),{code:'RATE_LIMITED'});}});
 assert.equal(calls,0);await h.click();h.ui.render();assert.equal(calls,1);assert.match(h.element('pilot-status').textContent,/유료 전환 없이/);assert.equal(h.element('pilot-arrival').textContent,'—');
});
test('logged out users never call the server',async()=>{
 let calls=0;const h=harness({arrivals:async()=>{calls++;return payload();}});h.logout();await h.click();assert.equal(calls,0);
});
