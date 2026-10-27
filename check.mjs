// 一键自检：本地两套单元用例 + 真实小红书站点回归
// 用法: node check.mjs [--real] [--shot]
// 说明：会自动拉起本地静态服务器(8125)与 headless Edge(9333)，跑完自己收掉
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const HTTP_PORT = 8125;
const CDP_PORT = 9333;
const WANT_REAL = process.argv.includes('--real') || process.argv.includes('--all');
const SHOT = process.argv.includes('--shot');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function portAlive(url) {
  try {
    const c = new AbortController();
    setTimeout(() => c.abort(), 1200);
    const r = await fetch(url, { signal: c.signal });
    return r.ok;
  } catch { return false; }
}

// ---------- 静态服务器 ----------
function startServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    const f = path.join(ROOT, u === '/' ? '/test.html' : u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((res) => srv.listen(HTTP_PORT, '127.0.0.1', () => res(srv)));
}

// ---------- 用 headless 跑一个 html 用例页 ----------
function runHtmlSuite(file) {
  return new Promise((resolve) => {
    const profile = path.join(ROOT, '.edge-run', file.replace(/\W/g, '_'));
    fs.rmSync(profile, { recursive: true, force: true });
    const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + profile, '--virtual-time-budget=20000', '--dump-dom',
      `http://127.0.0.1:${HTTP_PORT}/${file}`];
    const p = spawn(EDGE, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('close', () => {
      const lines = [...out.matchAll(/(PASS|FAIL) [^\n<]+/g)].map((m) => m[0].trim());
      const fails = lines.filter((l) => l.startsWith('FAIL'));
      const m = out.match(/=== (\d+) pass \/ (\d+) fail ===/);
      resolve({
        file,
        pass: m ? +m[1] : lines.filter((l) => l.startsWith('PASS')).length,
        fail: m ? +m[2] : fails.length,
        fails,
        raw: m ? '' : '未拿到汇总行（页面可能提前崩了）',
      });
    });
  });
}

function runNode(script, args = []) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { out += d.toString(); });
    p.on('close', (code) => resolve({ code, out }));
  });
}

(async () => {
  const t0 = Date.now();
  const summary = [];
  let srv = null, edge = null;

  try {
    if (!(await portAlive(`http://127.0.0.1:${HTTP_PORT}/test.html`))) {
      srv = await startServer();
      console.log('· 已启动本地静态服务器 :' + HTTP_PORT);
    }

    // 本地用例
    for (const f of ['test.html', 'test-scroll.html']) {
      const r = await runHtmlSuite(f);
      summary.push(r);
      console.log(`${r.fail === 0 ? '✓' : '✗'} ${r.file}  ${r.pass} pass / ${r.fail} fail`);
      r.fails.forEach((l) => console.log('    ' + l));
      if (r.raw) console.log('    ' + r.raw);
    }

    // 真实站点
    if (WANT_REAL) {
      if (!(await portAlive(`http://127.0.0.1:${CDP_PORT}/json/version`))) {
        fs.mkdirSync(path.join(ROOT, '.cdp'), { recursive: true });
        edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
          '--user-data-dir=' + path.join(ROOT, '.cdp/profile'), '--no-first-run',
          '--no-default-browser-check', '--disable-gpu', '--window-size=1440,900', 'about:blank'],
          { stdio: 'ignore' });
        for (let i = 0; i < 30; i++) {
          if (await portAlive(`http://127.0.0.1:${CDP_PORT}/json/version`)) break;
          await sleep(400);
        }
        console.log('· 已启动 headless Edge 调试端口 :' + CDP_PORT);
      }
      const sweepN = (process.argv.find((a) => /^--sweep=\d+$/.test(a)) || '').split('=')[1];
      if (sweepN) {
        const sw = await runNode('sweep.mjs', [sweepN]);
        const sm = sw.out.match(/=== 巡检 (\d+) pass \/ (\d+) fail(?: \/ (\d+) skip)? ===/);
        const sp = sm ? +sm[1] : 0, sf = sm ? +sm[2] : -1;
        summary.push({ file: 'sweep (真机巡检)', pass: sp, fail: sf });
        console.log(`${sf === 0 ? '✓' : '✗'} sweep  真机巡检 ${sp} pass / ${sf} fail` +
          (sm && sm[3] ? ` / ${sm[3]} skip` : ''));
        if (sf !== 0) console.log(sw.out.split('\n').filter((l) => l.startsWith('FAIL')).join('\n'));
      }
      const r = await runNode('real-check.mjs', SHOT ? ['--shot'] : []);
      const m = r.out.match(/=== 真实站点 (\d+) pass \/ (\d+) fail ===/);
      const pass = m ? +m[1] : 0, fail = m ? +m[2] : -1;
      summary.push({ file: 'real-check (真实站点)', pass, fail });
      console.log(`${fail === 0 ? '✓' : '✗'} real-check  真实站点 ${pass} pass / ${fail} fail`);
      if (fail !== 0) console.log(r.out.split('\n').filter((l) => l.startsWith('FAIL')).join('\n'));
    }
  } finally {
    if (srv) srv.close();
    if (edge) { try { edge.kill(); } catch {} }
  }

  const tp = summary.reduce((a, b) => a + b.pass, 0);
  const tf = summary.reduce((a, b) => a + b.fail, 0);
  console.log('\n──────────────');
  console.log(`合计 ${tp} pass / ${tf} fail   (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(tf === 0 ? 0 : 1);
})();
