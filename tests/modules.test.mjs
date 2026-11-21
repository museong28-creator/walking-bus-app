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

test('every element id the scripts look up exists exactly once in the page', async () => {
  const html = await read('index.html');
  const declared = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(declared).size, declared.length, 'duplicate id in index.html');
  const wanted = new Set();
  for (const name of sources) {
    for (const match of (await read(`src/${name}`)).matchAll(/\$\('([a-z0-9-]+)'\)/g)) wanted.add(match[1]);
  }
  assert.ok(wanted.size > 100, `only ${wanted.size} lookups were found; the scanner is broken`);
  const missing = [...wanted].filter(id => !declared.includes(id));
  assert.deepEqual(missing, []);
  // The three views share one map and are switched by these tabs.
  for (const id of ['view-main', 'view-bus', 'view-meet', 'recalibrate-button']) assert.ok(declared.includes(id), id);
});

test('the menu shows a name under every icon and the map controls keep their accessible names', async () => {
  const html = await read('index.html'), css = await read('styles.css');
  for (const [id, label] of [['view-main', '길찾기'], ['view-bus', '버스'], ['view-meet', '약속'], ['recalibrate-button', '내 속도'], ['account-button', '계정']]) {
    assert.match(html, new RegExp(`<button id="${id}">${label}</button>`), id);
  }
  // The labels are real text now: nothing may shrink them to nothing again.
  const tab = css.match(/^\.tabbar button \{([^}]*)\}/m)[1];
  assert.match(tab, /font-size: 11px/); assert.doesNotMatch(tab, /transparent/); assert.match(tab, /height: 56px/);
  assert.match(css, /\.tabbar \{[^}]*env\(safe-area-inset-bottom\)/);
  assert.match(html, /<button type="button" id="search-clear" class="search-clear hidden" aria-label="검색어 지우기"/);
  assert.match(html, /<button id="locate-me"[^>]*aria-label="현재 위치로 지도 이동"/);
  assert.match(html, /<button id="clear-destination"[^>]*aria-label="목적지 지우기"/);
});

test('search results sit above the chips, the sheet and its floating buttons, and the chips step aside', async () => {
  const css = await read('styles.css');
  const layer = selector => Number(css.match(new RegExp(`^${selector} \\{[^}]*z-index: (\\d+)`, 'm'))[1]);
  assert.ok(layer('\\.search-results') > layer('\\.sheet'), 'results under the sheet');
  assert.ok(layer('\\.sheet') > layer('\\.search-bar') && layer('\\.search-bar') > layer('\\.chips'));
  assert.ok(layer('\\.tabbar') > layer('\\.search-results'));
  assert.match(css, /\.map-frame:has\(\.search-results:not\(\.hidden\)\) \.chips \{ display: none; \}/);
});

test('the summary card comes first in the sheet and messages follow it, outside the inert panel', async () => {
  const html = await read('index.html');
  const at = id => html.indexOf(`id="${id}"`);
  assert.ok(at('sheet-scroll') < at('sheet-board') && at('sheet-board') < at('notice'), 'the notice is above the summary');
  assert.ok(at('notice') < at('gps-recovery') && at('gps-recovery') < at('journey-panel'), 'messages must stay outside the panel that is inert when collapsed');
  assert.match(html, /<div id="notice" class="notice hidden" role="status" aria-live="polite">/);
  assert.match(html, /<div id="gps-recovery" class="gps-recovery hidden" role="status">/);
});

test('dialog buttons are in the page in the order they are shown: outlined first, filled second', async () => {
  const html = await read('index.html'), css = await read('styles.css');
  assert.ok(html.indexOf('id="stop-close"') < html.indexOf('id="stop-walk"'));
  assert.ok(html.indexOf('id="consent-cancel"') < html.indexOf('id="consent-allow"'));
  assert.doesNotMatch(css, /.dialog-actions[^{]*{[^}]*order:/);
});
