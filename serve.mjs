// 本地更新源：给 Tampermonkey 提供 .user.js 与安装页（只读，仅绑定 127.0.0.1）
// 用法: node serve.mjs      端口默认 8125，可用 FZ_PORT 覆盖
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.FZ_PORT || 8125);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

const SCRIPT = 'xiaohongshu-fishy.user.js';

function scriptVersion() {
  try {
    const head = fs.readFileSync(path.join(ROOT, SCRIPT), 'utf8').slice(0, 800);
    const m = head.match(/@version\s+([\d.]+)/);
    return m ? m[1] : '';
  } catch { return ''; }
}

const server = http.createServer((req, res) => {
  let u = decodeURIComponent((req.url || '/').split('?')[0]);
  if (u === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('本地更新源运行中。\n脚本地址: /xiaohongshu-fishy.user.js\n版本: /version');
    return;
  }

  // 版本回执：油猴脚本每次加载都会 ping 一次，用来确认"实际在跑哪一版"
  if (u === '/hit') {
    try {
      const q = new URLSearchParams((req.url || '').split('?')[1] || '');
      const line = new Date().toISOString() + '\t v=' + (q.get('v') || '?') +
        '\t page=' + (q.get('p') || '') + '\t ua=' + String(req.headers['user-agent'] || '').slice(0, 70);
      fs.appendFileSync(path.join(ROOT, '.cdp', 'hits.log'), line + '\n');
      console.log('[hit] ' + line);
    } catch (e) {}
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end('ok');
    return;
  }

  // 版本探针
  if (u === '/version') {
    res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ version: scriptVersion(), file: SCRIPT }));
    return;
  }

  const f = path.join(ROOT, u);
  if (!f.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  // 不暴露隐藏目录（.cdp/.edge* 等）
  if (path.relative(ROOT, f).split(path.sep).some((seg) => seg.startsWith('.'))) {
    res.writeHead(404); res.end('not found'); return;
  }

  const ext = path.extname(f).toLowerCase();
  const headers = {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  };
  // 油猴脚本希望被当作文本直接读，避免被浏览器当成下载
  if (u.endsWith('.user.js')) headers['Content-Disposition'] = 'inline';
  res.writeHead(200, headers);
  fs.createReadStream(f).pipe(res);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') process.exit(0);   // 已有实例在跑，静静退出
  process.exit(0);
});

server.listen(PORT, '127.0.0.1', () => {
  const v = scriptVersion();
  console.log('[fishy-serve] 更新源已就绪 http://127.0.0.1:' + PORT + '/  (脚本版本 ' + v + ')');
});
