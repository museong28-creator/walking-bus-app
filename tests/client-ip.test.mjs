import test from 'node:test';
import assert from 'node:assert/strict';
import {clientIp, proxyHops} from '../server/client-ip.mjs';

const request = (remoteAddress, forwarded) => ({socket: {remoteAddress}, headers: forwarded === undefined ? {} : {'x-forwarded-for': forwarded}});

test('without a declared proxy the forwarded header is ignored and cannot spoof the visitor', () => {
  assert.equal(clientIp(request('203.0.113.9', '198.51.100.1')), '203.0.113.9');
  assert.equal(clientIp(request('::ffff:203.0.113.9')), '203.0.113.9');
});

test('behind proxies the visitor is the entry appended by the outermost trusted proxy', () => {
  assert.equal(clientIp(request('10.0.0.1', '198.51.100.7'), 1), '198.51.100.7');
  // The visitor prepends a forged entry: only the proxy-appended entry counts.
  assert.equal(clientIp(request('10.0.0.1', '1.2.3.4, 198.51.100.7'), 1), '198.51.100.7');
  assert.equal(clientIp(request('10.0.0.1', '1.2.3.4, 198.51.100.7, 172.16.0.5'), 2), '198.51.100.7');
  assert.equal(clientIp(request('10.0.0.1', ['1.2.3.4', '2001:db8::7']), 1), '2001:db8::7');
});

test('a missing, short or malformed forwarded chain falls back to the socket address', () => {
  assert.equal(clientIp(request('10.0.0.1'), 1), '10.0.0.1');
  assert.equal(clientIp(request('10.0.0.1', '198.51.100.7'), 2), '10.0.0.1');
  assert.equal(clientIp(request('10.0.0.1', 'not-an-ip'), 1), '10.0.0.1');
  assert.equal(clientIp(request('10.0.0.1', '198.51.100.7,'), 1), '10.0.0.1');
});

test('proxy hop configuration accepts only small non-negative integers', () => {
  assert.equal(proxyHops(undefined), 0);
  assert.equal(proxyHops(''), 0);
  assert.equal(proxyHops('2'), 2);
  assert.equal(proxyHops(1), 1);
  for (const value of ['-1', '1.5', 'all', '6', true]) assert.throws(() => proxyHops(value));
});
