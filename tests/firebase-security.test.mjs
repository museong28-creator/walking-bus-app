import test from 'node:test';
import assert from 'node:assert/strict';
import {createFirebaseSecurity,loadFirebaseSecurity} from '../server/firebase-security.mjs';
const projectId='fixture-project';
const valid={uid:'owner',aud:projectId,iss:`https://securetoken.google.com/${projectId}`,email_verified:true,firebase:{sign_in_provider:'google.com'}};
const request={headers:{authorization:'Bearer fixture.token.signature'}};
function mockDB(){
  const records=new Map();let tail=Promise.resolve();
  return {records,collection:()=>({doc:id=>id}),runTransaction(fn){
    const task=tail.then(()=>fn({getAll:async(...refs)=>refs.map(ref=>({exists:records.has(ref),data:()=>records.get(ref)})),set:(ref,value)=>records.set(ref,value)}));
    tail=task.catch(()=>{});return task;
  }};
}
const make=(options={})=>createFirebaseSecurity({auth:{verifyIdToken:async()=>valid},db:mockDB(),projectId,allowedUids:['owner'],...options});
test('requires configured owner allowlist and safe quotas',()=>{
  assert.throws(()=>make({allowedUids:[]}));assert.throws(()=>make({perUserDailyLimit:0}));
});
test('verifies revocation and admits only allowed verified Google identity',async()=>{
  let seen;const security=make({auth:{verifyIdToken:async(...args)=>{seen=args;return valid;}}});
  assert.deepEqual(await security.authorize(request),{uid:'owner'});assert.deepEqual(seen,['fixture.token.signature',true]);
  for(const claims of [{...valid,uid:'stranger'},{...valid,email_verified:false},{...valid,aud:'another-project'},
    {...valid,iss:'bad'},{...valid,firebase:{sign_in_provider:'password'}}]){
    assert.equal(await make({auth:{verifyIdToken:async()=>claims}}).authorize(request),false);
  }
  assert.equal(await make({auth:{verifyIdToken:async()=>{throw Error('revoked');}}}).authorize(request),false);
});
test('malformed bearer headers rejected before network',async()=>{
  let calls=0;const s=make({auth:{verifyIdToken:async()=>{calls++;return valid;}}});
  for(const authorization of [undefined,'Basic abc','Bearer abc def','Bearer '+'a'.repeat(8200)])assert.equal(await s.authorize({headers:{authorization}}),false);
  assert.equal(calls,0);
});
test('global durable quota survives adapter recreation and serializes concurrent reservations',async()=>{
  const db=mockDB(),now=()=>Date.UTC(2026,10,12,1),day='2026-11-12';
  const a=make({db,now,perUserMinuteLimit:60});const b=make({db,now,perUserMinuteLimit:60});
  const results=await Promise.all(Array.from({length:20},(_,i)=>(i%2?a:b).reserveQuota({day,limit:5,uid:'owner'})));
  assert.equal(results.filter(Boolean).length,5);
  assert.equal(await make({db,now}).reserveQuota({day,limit:5,uid:'owner'}),false);
  assert.equal(db.records.get('global_2026-11-12').count,5);
});
test('per-user daily and minute quotas cannot be bypassed by a second identity',async()=>{
  const db=mockDB();let time=Date.UTC(2026,10,12,1);const day='2026-11-12';
  const s=make({db,now:()=>time,allowedUids:['owner','friend'],perUserMinuteLimit:1,perUserDailyLimit:2});
  const take=uid=>s.reserveQuota({day,limit:10,uid});
  assert.equal(await take('owner'),true);assert.equal(await take('owner'),false);assert.equal(await take('friend'),true);
  time+=60000;assert.equal(await take('owner'),true);time+=60000;assert.equal(await take('owner'),false);
  assert.equal(db.records.get('global_2026-11-12').count,3);
});
test('storage error, unknown owner, wrong day and corrupt counters fail closed',async()=>{
  const now=()=>Date.UTC(2026,10,12,1),day='2026-11-12';
  const db=mockDB(),s=make({db,now});
  assert.equal(await s.reserveQuota({day,limit:10,uid:'stranger'}),false);
  assert.equal(await s.reserveQuota({day:'2026-11-11',limit:10,uid:'owner'}),false);
  db.records.set('global_2026-11-12',{count:-1});assert.equal(await s.reserveQuota({day,limit:10,uid:'owner'}),false);
  const broken=make({now,db:{collection:()=>({doc:()=>({})}),runTransaction:async()=>{throw Error('secret');}}});
  assert.equal(await broken.reserveQuota({day,limit:10,uid:'owner'}),false);
});
test('missing/malformed server credentials leave security locked without SDK import',async()=>{
  assert.equal(await loadFirebaseSecurity({}),null);
  assert.equal(await loadFirebaseSecurity({NAV_FIREBASE_PROJECT_ID:projectId,NAV_ALLOWED_FIREBASE_UIDS:'owner',NAV_FIREBASE_SERVICE_ACCOUNT_JSON:'{'}),null);
});
