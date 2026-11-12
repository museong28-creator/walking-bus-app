import test from 'node:test';
import assert from 'node:assert/strict';
import {initAccountUI} from '../src/account-ui.js';
import {createAccountSession} from '../src/firebase-session.js';
function harness(navigation){
 const elements=new Map();const $=id=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,textContent:'',value:'',open:false,events:{},addEventListener(name,fn){this.events[name]=fn;},showModal(){this.open=true;},close(){this.open=false;},select(){this.selected=true;}});return elements.get(id);};
 let user=null,watch,loads=0,loginCalls=0,cancel=false;const copied=[];
 const session=createAccountSession({loadSDK:async()=>{loads++;return {user:()=>user,watch:fn=>{watch=fn;},signIn:async()=>{loginCalls++;if(cancel){cancel=false;throw {code:'auth/popup-closed-by-user'};}user={uid:'owner-uid',displayName:'<script>not HTML</script>'};watch(user);},signOut:async()=>{user=null;watch(null);},getToken:async()=> 'secret-never-display'};}});
 initAccountUI({document:{getElementById:$},session,clipboard:{writeText:async text=>copied.push(text)},navigation});
 return {$,session,copied,stats:()=>({loads,loginCalls}),cancel:()=>{cancel=true;},click:id=>$(id).events.click()};
}
test('opening/closing never loads Google; preparation, popup cancellation retry and logout clear identity',async()=>{
 const h=harness();h.click('account-button');assert.equal(h.$('account-dialog').open,true);h.click('account-close');assert.equal(h.stats().loads,0);
 await h.click('account-prepare');assert.equal(h.stats().loads,1);assert.equal(h.$('account-login').hidden,false);
 h.cancel();await h.click('account-login');assert.match(h.$('account-status').textContent,/취소/);assert.equal(h.$('account-login').disabled,false);
 await h.click('account-login');assert.equal(h.$('account-uid').value,'owner-uid');assert.equal(h.$('account-name').textContent,'<script>not HTML</script>');
 await h.click('account-copy');assert.deepEqual(h.copied,['owner-uid']);
 h.click('account-close');h.click('account-button');await h.click('account-logout');assert.equal(h.$('account-uid').value,'');assert.equal(h.$('account-identity').hidden,true);
});
test('repeated clicks do not start duplicate login',async()=>{
 const h=harness();await h.click('account-prepare');await Promise.all([h.click('account-login'),h.click('account-login')]);assert.equal(h.stats().loginCalls,1);
});

test('protection check shows immediate progress, prevents duplicates, and restores button',async()=>{
 let resolve,calls=0;const h=harness({sessionCheck:()=>{calls++;return new Promise(r=>resolve=r);}});
 await h.click('account-prepare');await h.click('account-login');
 const pending=h.click('account-check');await h.click('account-check');
 assert.equal(calls,1);assert.match(h.$('account-check').textContent,/확인 중/);assert.equal(h.$('account-check').disabled,true);
 resolve({});await pending;assert.match(h.$('account-status').textContent,/확인 완료/);assert.equal(h.$('account-check').disabled,false);assert.equal(h.$('account-check').textContent,'서버 보호 연결 확인');
});
test('protection check maps safe errors without exposing server/token content',async()=>{
 for(const [code,expected] of [['AUTH_REQUIRED',/만료/],['ACCESS_DENIED',/권한/],['RATE_LIMITED',/한도/],['UNAVAILABLE',/설정/]]){
  const h=harness({sessionCheck:async()=>{throw Object.assign(new Error('private-token'),{code});}});
  await h.click('account-prepare');await h.click('account-login');await h.click('account-check');
  assert.match(h.$('account-status').textContent,expected);assert.doesNotMatch(h.$('account-status').textContent,/private-token/);assert.equal(h.$('account-check').disabled,false);
 }
});
