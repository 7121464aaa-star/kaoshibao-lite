/* serve.mjs —— 本地静态服务器（M4）：在 localhost 上实测 PWA（SW/manifest/离线）。
   用法：node tools/serve.mjs [port] [dir]
     默认端口 8080；默认目录 dist/（先跑 tools/build-single.mjs 生成）。
     例：node tools/serve.mjs 8080 dist
   说明：PWA 的 Service Worker 只工作于 http(s) 且 localhost 视为安全上下文，可直接联调。 */
import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = parseInt(process.argv[2] || process.env.PORT || '8080', 10);
const base = process.argv[3] ? join(process.cwd(), process.argv[3]) : join(root, 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let p = normalize(join(base, urlPath === '/' ? 'index.html' : urlPath));
    if (!p.startsWith(base)) return send(res, 403, 'Forbidden');
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
    if (!existsSync(p)) return send(res, 404, 'Not Found: ' + urlPath);
    const data = readFileSync(p);
    send(res, 200, data, MIME[extname(p).toLowerCase()] || 'application/octet-stream');
  } catch (e) {
    send(res, 500, 'Server error: ' + e.message);
  }
}).listen(port, () => {
  console.log('✔ 本地服务器: http://localhost:' + port + '  （目录 ' + base + '）');
  console.log('  在 Chrome 打开后，可用 DevTools → Application 检查 Service Worker 与 Manifest。');
});
