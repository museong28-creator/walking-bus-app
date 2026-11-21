import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createPreviewServer, withoutMapKey} from '../scripts/serve.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const onDisk = await readFile(new URL('../src/map-config.js', import.meta.url), 'utf8');
const keyOf = source => source.match(/KAKAO_JAVASCRIPT_KEY\s*=\s*'([^']*)'/)?.[1];

async function preview(t, options) {
  const server = createPreviewServer({root, ...options});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return path => fetch(`http://127.0.0.1:${server.address().port}${path}`);
}

test('withoutMapKey empties only the key and keeps the rest of the module', () => {
  const source = "// note\nexport const KAKAO_JAVASCRIPT_KEY = 'abc123';\nexport const OTHER = 'keep';\n";
  assert.equal(withoutMapKey(source), "// note\nexport const KAKAO_JAVASCRIPT_KEY = '';\nexport const OTHER = 'keep';\n");
  assert.equal(withoutMapKey('export const KAKAO_JAVASCRIPT_KEY="abc";'), "export const KAKAO_JAVASCRIPT_KEY='';");
  assert.equal(keyOf(withoutMapKey(onDisk)), '');
  // A renamed constant must fail loudly instead of silently serving the real key.
  assert.throws(() => withoutMapKey("export const MAP_KEY = 'abc';"));
});

test('--osm serves the map config with an empty key and leaves every other file alone', async t => {
  const get = await preview(t, {osm:true});
  const config = await get('/src/map-config.js');
  assert.equal(config.status, 200);
  assert.match(config.headers.get('content-type'), /javascript/);
  const text = await config.text();
  assert.equal(keyOf(text), '');
  const key = keyOf(onDisk);
  if (key) assert.ok(!text.includes(key), 'the real key was served');
  if (key) assert.ok(!(await (await get('/SRC/MAP-CONFIG.JS')).text()).includes(key), 'a differently cased URL served the real key');
  assert.equal(await (await get('/src/core.js')).text(), await readFile(new URL('../src/core.js', import.meta.url), 'utf8'));
  assert.match(await (await get('/')).text(), /<title>몇분 걸음/);
  // The file on disk is untouched.
  assert.equal(await readFile(new URL('../src/map-config.js', import.meta.url), 'utf8'), onDisk);
});

test('without --osm the map config is served exactly as it is on disk', async t => {
  const get = await preview(t);
  assert.equal(await (await get('/src/map-config.js')).text(), onDisk);
  assert.equal((await get('/no-such-file.js')).status, 404);
  assert.notEqual((await get('/..%2f..%2fsecret')).status, 200);
});
