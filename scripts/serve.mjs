import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
const args = process.argv.slice(2);
const arg = (name,fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const port = Number(arg('--port','3000')), host = arg('--host','127.0.0.1');
const root = process.cwd();
const types = {'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.webmanifest':'application/manifest+json','.md':'text/plain; charset=utf-8'};
http.createServer(async (req,res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    let file = path.resolve(root,`.${pathname}`);
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    if ((await stat(file)).isDirectory()) file = path.join(file,'index.html');
    const data = await readFile(file);
    res.writeHead(200,{'Content-Type':types[path.extname(file)] || 'application/octet-stream','Cache-Control':'no-cache'}).end(data);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port,host,() => console.log(`Local preview: http://${host}:${port}`));
