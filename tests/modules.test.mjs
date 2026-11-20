import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir, access} from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const sources = (await readdir(new URL('src/', root))).filter(name => name.endsWith('.js')).sort();
const importsOf = text => [...text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm)].map(match => match[1] ?? match[2] ?? match[3]);
const swFiles = async () => {
  const list = (await read('sw.js')).match(/const FILES = \[([\s\S]*?)\];/)[1];
  return [...list.matchAll(/'([^']+)'/g)].map(match => match[1]);
};

test('every module has exactly one URL: no import carries a ?v= or other query string', async () => {
  // './core.js' and './core.js?v=1' are two module instances with separate state.
  let checked = 0;
  for (const name of sources) {
    for (const specifier of importsOf(await read(`src/${name}`))) {
      if (!specifier.startsWith('.')) continue;
      checked++;
      assert.doesNotMatch(specifier, /[?#]/, `${name} imports ${specifier}`);
      assert.ok(sources.includes(specifier.replace(/^\.\//, '')), `${name} imports missing module ${specifier}`);
    }
  }
  assert.ok(checked >= 15, `only ${checked} imports were found; the import scanner is broken`);
});

test('the page loads its own script and stylesheet without query strings', async () => {
  const html = await read('index.html');
  const local = [...html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g)].map(match => match[1]).filter(url => !/^https?:/.test(url));
  assert.ok(local.includes('src/app.js') && local.includes('styles.css'), local.join(', '));
  for (const url of local) {
    assert.doesNotMatch(url, /[?#]/, url);
    await access(new URL(url, root));
  }
});

test('the offline cache lists every source file once, and only files that exist', async () => {
  const files = await swFiles();
  assert.equal(new Set(files).size, files.length, 'duplicate cache entry');
  for (const file of files) {
    assert.doesNotMatch(file, /[?#]/, file);
    if (file !== './') await access(new URL(file, root));
  }
  for (const name of sources) assert.ok(files.includes(`./src/${name}`), `sw.js does not cache src/${name}`);
  for (const required of ['./', './index.html', './styles.css', './manifest.webmanifest', './assets/vendor/leaflet.js', './assets/vendor/leaflet.css']) {
    assert.ok(files.includes(required), `sw.js does not cache ${required}`);
  }
});

test('the offline fallback revalidates with the server so releases never mix old and new modules', async () => {
  assert.match(await read('sw.js'), /fetch\(event\.request,\{cache:'no-cache'\}\)/);
});
