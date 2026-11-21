import test from 'node:test';
import assert from 'node:assert/strict';
import {initLoginGate, loginErrorMessage} from '../src/login-gate.js';
import {createAccountSession} from '../src/firebase-session.js';

function harness({failLoad = false} = {}) {
  const elements = new Map(), classes = new Set(['locked']);
  const $ = id => { if (!elements.has(id)) elements.set(id, {textContent: id === 'login-status' ? 'initial disclosure' : '', disabled: false, events: {}, addEventListener(name, fn) { this.events[name] = fn; }}); return elements.get(id); };
  const body = {classList: {toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }}};
  let user = null, watch, loads = 0, logins = 0, loginError = null;
  const session = createAccountSession({loadSDK: async () => {
    loads++; if (failLoad) throw new Error('offline');
    return {user: () => user, watch: fn => { watch = fn; }, getToken: async () => 'token',
      signIn: async () => { logins++; if (loginError) throw loginError; user = {uid: 'friend-uid'}; watch(user); },
      signOut: async () => { user = null; }};
  }});
  const events = [];
  initLoginGate({document: {getElementById: $, body}, session, onSignedIn: value => events.push(`in:${value.uid}`), onSignedOut: () => events.push('out')});
  return {$, session, events, locked: () => classes.has('locked'), click: () => $('login-start').events.click(),
    get loads() { return loads; }, get logins() { return logins; }, failLogin(error) { loginError = error; }, restore(value) { user = value; }};
}

test('the app stays locked and loads nothing from Google until the button is pressed', () => {
  const h = harness();
  assert.equal(h.locked(), true); assert.equal(h.loads, 0); assert.deepEqual(h.events, []);
  assert.equal(h.$('login-start').textContent, 'Google로 시작하기');
  assert.equal(h.$('login-status').textContent, 'initial disclosure');
});

test('first tap prepares the login, second tap opens the account choice and unlocks once', async () => {
  const h = harness();
  await h.click();
  assert.equal(h.loads, 1); assert.equal(h.logins, 0); assert.equal(h.locked(), true);
  assert.equal(h.$('login-start').textContent, 'Google 계정 선택');
  assert.match(h.$('login-status').textContent, /한 번 더/);
  await h.click();
  assert.equal(h.logins, 1); assert.equal(h.locked(), false); assert.deepEqual(h.events, ['in:friend-uid']);
  // Further taps while signed in do nothing.
  await h.click();
  assert.equal(h.logins, 1); assert.deepEqual(h.events, ['in:friend-uid']);
});

test('a login that is still valid in this tab unlocks on the first tap without an account window', async () => {
  const h = harness(); h.restore({uid: 'friend-uid'});
  await h.click();
  assert.equal(h.logins, 0); assert.equal(h.locked(), false); assert.deepEqual(h.events, ['in:friend-uid']);
});

test('a cancelled or blocked login keeps the app locked with an explanation and can be retried', async () => {
  const h = harness();
  await h.click();
  h.failLogin({code: 'auth/popup-blocked'});
  await h.click();
  assert.equal(h.locked(), true); assert.deepEqual(h.events, []);
  assert.match(h.$('login-status').textContent, /팝업/);
  assert.equal(h.$('login-start').disabled, false);
  h.failLogin(null);
  await h.click();
  assert.equal(h.locked(), false);
});

test('a network failure while preparing is reported and leaves the first step available', async () => {
  const h = harness({failLoad: true});
  await h.click();
  assert.equal(h.locked(), true); assert.match(h.$('login-status').textContent, /인터넷/);
  assert.equal(h.$('login-start').textContent, 'Google로 시작하기'); assert.equal(h.$('login-start').disabled, false);
});

test('logging out locks the app again and restores the disclosure', async () => {
  const h = harness();
  await h.click(); await h.click();
  await h.session.logout();
  assert.equal(h.locked(), true); assert.deepEqual(h.events, ['in:friend-uid', 'out']);
  assert.equal(h.$('login-status').textContent, 'initial disclosure');
});

test('login errors never expose raw error text', () => {
  assert.match(loginErrorMessage({code: 'auth/popup-closed-by-user'}), /취소/);
  assert.match(loginErrorMessage({code: 'auth/unauthorized-domain'}), /도메인/);
  assert.doesNotMatch(loginErrorMessage(new Error('secret-token-123')), /secret/);
});
