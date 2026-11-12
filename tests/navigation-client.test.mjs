import test from 'node:test';
import assert from 'node:assert/strict';
import {createNavigationClient,arrivalIsFresh} from '../src/navigation-client.js';
const origin='https://navigation.example', now=1700000000000;
const arrivals=()=>({provider:'TAGO',status:'estimated',fetchedAt:new Date(now).toISOString(),expiresAt:new Date(now+30000).toISOString(),arrivals:[{routeId:'DJB1',routeName:'102',etaSeconds:80}]});
const setup=(payload,options={})=>createNavigationClient({origin,now:()=>now,fetchImpl:async()=>({ok:true,json:async()=>payload}),...options});
test('server requires HTTPS origin without credentials or path',()=>{for(const origin of ['http://example.com','https://example.com/path','https://user:pass@example.com','https://example.com?key=secret'])assert.throws(()=>createNavigationClient({origin}));});
test('coordinates use JSON body, requests never follow login redirects or persist responses',async()=>{
 let call;const client=setup({stops:[]},{fetchImpl:async(url,opts)=>{call={url,opts};return {ok:true,json:async()=>({stops:[]})};}});
 await client.stops([37,127]);assert.equal(call.url,origin+'/v1/stops');assert.deepEqual(JSON.parse(call.opts.body),{point:[37,127]});assert.equal(call.opts.redirect,'error');assert.equal(call.opts.cache,'no-store');assert.equal(call.opts.credentials,'same-origin');
});
test('invalid coordinates and OSM stop IDs do not trigger request',async()=>{let count=0;const c=setup(null,{fetchImpl:async()=>{count++;}});await assert.rejects(c.stops([91,0]));await assert.rejects(c.arrivals('',123));assert.equal(count,0);});
test('valid arrival ages expire after 30 seconds, including no-data results',async()=>{assert.equal((await setup(arrivals()).arrivals('25','DJB1')).arrivals[0].etaSeconds,80);assert.equal(arrivalIsFresh(arrivals(),now+30000),false);const stale=arrivals();stale.expiresAt=new Date(now-1).toISOString();await assert.rejects(setup(stale).arrivals('25','DJB1'),/오래/);});
test('malformed or inconsistent arrivals rejected, never fabricated',async()=>{for(const p of [{...arrivals(),status:'no_data'},{...arrivals(),arrivals:[{routeId:'x',routeName:'1',etaSeconds:-1}]},{...arrivals(),provider:'OSM'}])await assert.rejects(setup(p).arrivals('25','DJB1'));});
test('server errors do not expose upstream response bodies',async()=>{for(const status of [401,403,429,503,502])await assert.rejects(setup(null,{fetchImpl:async()=>({ok:false,status,json:async()=>({error:'secret'})})}).cities(),e=>!e.message.includes('secret'));});
test('already cancelled requests never send coordinates',async()=>{let calls=0;const abort=new AbortController();abort.abort();await assert.rejects(setup(null,{fetchImpl:async()=>{calls++;}}).stops([37,127],abort.signal),{name:'AbortError'});assert.equal(calls,0);});
test('destination changed while response parsed discards stale result',async()=>{const abort=new AbortController();const client=setup(null,{fetchImpl:async()=>({ok:true,json:async()=>{abort.abort();return {cities:[]};}})});await assert.rejects(client.cities(abort.signal),{name:'AbortError'});});
test('walking validates geometry and avoids unannounced fallback provider',async()=>{const route={points:[[37,127],[37.01,127.01]],distance:1400,snapDistance:0,source:'Kakao 도보 경로'};assert.equal((await setup(route).walking(...route.points)).distance,1400);await assert.rejects(setup({...route,source:'other'}).walking(...route.points));});

test('timeout bounds token retrieval even if SDK never resolves',async()=>{
 const {NAVIGATION_API_ORIGIN}=await import('../src/firebase-config.js');let requests=0;
 const client=createNavigationClient({origin:NAVIGATION_API_ORIGIN,timeoutMs:10,getIdToken:()=>new Promise(()=>{}),fetchImpl:async()=>{requests++;}});
 await assert.rejects(client.cities(),{name:'AbortError'});assert.equal(requests,0);
});
test('timeout bounds unresponsive transport and response parsing',async()=>{
 await assert.rejects(setup(null,{timeoutMs:10,fetchImpl:()=>new Promise(()=>{})}).cities(),{name:'AbortError'});
 await assert.rejects(setup(null,{timeoutMs:10,fetchImpl:async()=>({ok:true,json:()=>new Promise(()=>{})})}).cities(),{name:'AbortError'});
});
