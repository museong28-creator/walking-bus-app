import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const types = {'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.webmanifest':'application/manifest+json','.md':'text/plain; charset=utf-8'};

// Local preview only (--osm). The Kakao key is restricted to the published domain, so on
// localhost the Kakao map cannot load. Serving the config with an empty key makes the app use its
// own OpenStreetMap / Leaflet fallback. The file on disk is never changed.
export function withoutMapKey(source) {
  const pattern = /(\bKAKAO_JAVASCRIPT_KEY\s*=\s*)(['"`])[^'"`\r\n]*\2/;
  if (!pattern.test(source)) throw new Error('KAKAO_JAVASCRIPT_KEY was not found in src/map-config.js');
  return source.replace(pattern, "$1''");
}

export function createPreviewServer({root = process.cwd(), osm = false} = {}) {
  root = path.resolve(root);
  const mapConfig = path.join(root,'src','map-config.js');
  return http.createServer(async (req,res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      let file = path.resolve(root,`.${pathname}`);
      if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      if ((await stat(file)).isDirectory()) file = path.join(file,'index.html');
      let data = await readFile(file);
      // path.relative also matches a differently cased URL on case-insensitive file systems.
      if (osm && path.relative(mapConfig,file) === '') data = withoutMapKey(data.toString('utf8'));
      res.writeHead(200,{'Content-Type':types[path.extname(file)] || 'application/octet-stream','Cache-Control':'no-cache'}).end(data);
    } catch { res.writeHead(404).end('Not found'); }
  });
}

// True when this file is the script being run. Paths are compared after resolving links, and
// without regard to case on Windows, where the drive letter can arrive as "c:" or "C:".
function runDirectly() {
  if (!process.argv[1]) return false;
  const same = value => { const real = realpathSync(value); return process.platform === 'win32' ? real.toLowerCase() : real; };
  try { return same(process.argv[1]) === same(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (runDirectly()) {
  const args = process.argv.slice(2);
  const arg = (name,fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const port = Number(arg('--port','3000')), host = arg('--host','127.0.0.1'), osm = args.includes('--osm');
  createPreviewServer({osm}).listen(port,host,() => console.log(`Local preview: http://${host}:${port}${osm ? ' (OpenStreetMap fallback, Kakao key not served)' : ''}`));
}
