// Rate limits must be keyed on the visitor, not on the hosting platform's proxy.
// Behind a reverse proxy (Render, nginx, ...) every socket comes from the proxy, so
// req.socket.remoteAddress alone puts all visitors into one shared bucket.
import {isIP} from 'node:net';

export const normalizeIp = value => String(value ?? '').replace(/^::ffff:/, '');

export function proxyHops(value, name = 'trustedProxyHops') {
  if (value === undefined || value === null || value === '') return 0;
  if (!/^\d+$/.test(String(value)) || Number(value) > 5) throw new Error(`${name} must be an integer from 0 to 5.`);
  return Number(value);
}

// hops = how many trusted proxies sit in front of this process. Each proxy appends the
// address it received the request from, so the visitor is the hops-th entry from the right
// of X-Forwarded-For. Entries further left are supplied by the visitor and are never trusted.
// With hops = 0 the header is ignored completely. A missing or malformed entry falls back to
// the socket address, which is the previous (shared but safe) behaviour.
export function clientIp(req, hops = 0) {
  const peer = normalizeIp(req.socket?.remoteAddress);
  if (!hops) return peer;
  const header = req.headers?.['x-forwarded-for'];
  const chain = (Array.isArray(header) ? header.join(',') : String(header ?? '')).split(',').map(entry => normalizeIp(entry.trim()));
  const candidate = chain[chain.length - hops];
  return candidate && isIP(candidate) ? candidate : peer;
}
