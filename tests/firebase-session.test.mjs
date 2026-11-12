import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccountSession} from '../src/firebase-session.js';
import {createNavigationClient} from '../src/navigation-client.js';
import {NAVIGATION_API_ORIGIN} from '../src/firebase-config.js';
test('session loads only on consent; duplicate preparation shares one SDK and logout clears identity',async()=>{
  let loads=0,watch,signin=0;let user=null;
  const session=createAccountSession({loadSDK:async()=>{loads++;return {watch:fn=>{watch=fn;},user:()=>user,signIn:async()=>{signin++;user={uid:'owner'};watch(user);},signOut:async()=>{user=null;},getToken:async()=> 'fixture.token.value'};}});
  assert.equal(loads,0);await assert.rejects(session.getIdToken());assert.throws(()=>session.login());
  await Promise.all([session.prepare(),session.prepare()]);assert.equal(loads,1);
  await session.login();assert.equal(signin,1);assert.equal(session.user.uid,'owner');assert.equal(await session.getIdToken(),'fixture.token.value');
  await session.logout();assert.equal(session.user,null);await assert.rejects(session.getIdToken());
});
test('failed SDK loading can be retried',async()=>{
  let attempts=0;const s=createAccountSession({loadSDK:async()=>{if(++attempts===1)throw Error();return {watch:()=>{},user:()=>null};}});
  await assert.rejects(s.prepare());await s.prepare();assert.equal(s.ready,true);
});
test('bearer only reaches the fixed trusted backend, never body or URL',async()=>{
  let seen;
  const c=createNavigationClient({origin:NAVIGATION_API_ORIGIN,getIdToken:async()=> 'fixture.token.value',fetchImpl:async(url,options)=>{seen={url,options};return new Response('{"cities":[]}');}});
  await c.cities();assert.equal(seen.options.headers.Authorization,'Bearer fixture.token.value');assert.equal(seen.options.body,'{}');assert.ok(!seen.url.includes('fixture'));
  let calls=0;
  const bad=createNavigationClient({origin:'https://evil.example',getIdToken:async()=>{calls++;return 'fixture';},fetchImpl:()=>{calls++;}});
  await assert.rejects(bad.cities());assert.equal(calls,0);
});
test('signed-out request never fetches, abort during token acquisition never fetches',async()=>{
  let calls=0;
  const c=createNavigationClient({origin:NAVIGATION_API_ORIGIN,getIdToken:async()=>{throw Error('secret');},fetchImpl:()=>{calls++;}});
  await assert.rejects(c.cities(),e=>!e.message.includes('secret'));assert.equal(calls,0);
  const controller=new AbortController();
  const aborted=createNavigationClient({origin:NAVIGATION_API_ORIGIN,getIdToken:async()=>{controller.abort();return 'fixture';},fetchImpl:()=>{calls++;}});
  await assert.rejects(aborted.cities(controller.signal),{name:'AbortError'});assert.equal(calls,0);
});
test('session check validates server identity/quota response without claiming live provider data',async()=>{
 const c=createNavigationClient({origin:NAVIGATION_API_ORIGIN,getIdToken:async()=> 'fixture.token',fetchImpl:async()=>new Response(JSON.stringify({authenticated:true,quotaReservation:true,liveNavigation:false}))});
 assert.equal((await c.sessionCheck()).liveNavigation,false);
});
