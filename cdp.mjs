// 用 CDP 驱动本地 headless Edge：注入油猴脚本源码 → 打开真实页面 → 读断言 → 截图
// 用法: node cdp.mjs plan.json
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.FZ_CDP_PORT || 9333;
const planPath = process.argv[2];
if (!planPath) { console.error('usage: node cdp.mjs plan.json'); process.exit(2); }
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const baseDir = plan.baseDir || process.cwd();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', (e) => rej(e));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const a = (msg.params.args || []).map((x) => x.value ?? x.description ?? x.type);
        this.logs.push('[' + msg.params.type + '] ' + a.join(' '));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.logs.push('[exception] ' + (d.exception?.description || d.text));
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); }
      }, 60000);
    });
  }
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      return { __error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    }
    return r.result.value;
  }
}

const out = { steps: [] };

(async () => {
  // 每次跑都用全新标签页，避免上一轮的注入脚本残留
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
  const page = await created.json();
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 去掉 HeadlessChrome 标记，避免被站点识别
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0';
  await cdp.send('Network.enable');
  await cdp.send('Network.setUserAgentOverride', { userAgent: ua });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });

  // 注入脚本：等价 @run-at document-start，每个新文档都会先跑它
  const scripts = [];
  for (const f of plan.inject || []) {
    const src = fs.readFileSync(path.resolve(baseDir, f), 'utf8');
    const r = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
    scripts.push(r.identifier);
  }

  for (const step of plan.steps || []) {
    const label = step.label || step.nav || (step.eval ? 'eval' : Object.keys(step)[0]);
    try {
      if (step.nav) {
        const loaded = new Promise((res) => {
          const t = setTimeout(res, 25000);
          const h = (ev) => {
            const m = JSON.parse(ev.data);
            if (m.method === 'Page.loadEventFired') { clearTimeout(t); res(); }
          };
          cdp.ws.addEventListener('message', h);
        });
        await cdp.send('Page.navigate', { url: step.nav });
        await loaded;
        out.steps.push({ label, ok: true, url: step.nav });
      } else if (step.wait) {
        await sleep(step.wait);
      } else if (step.eval) {
        const v = await cdp.evaluate(step.eval);
        out.steps.push({ label, result: v });
      } else if (step.evalFile) {
        const src = fs.readFileSync(path.resolve(baseDir, step.evalFile), 'utf8');
        const v = await cdp.evaluate(src);
        out.steps.push({ label, result: v });
      } else if (step.viewport) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: step.viewport.w || 1100, height: step.viewport.h || 700,
          deviceScaleFactor: 1, mobile: false,
        });
        out.steps.push({ label, ok: true, viewport: step.viewport });
      } else if (step.wheel) {
        const times = step.wheel.times || 6, gap = step.wheel.gap || 900;
        for (let i = 0; i < times; i++) {
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: step.wheel.x || 720, y: step.wheel.y || 450,
            deltaX: 0, deltaY: step.wheel.delta || 1200, pointerType: 'mouse',
          });
          await sleep(gap);
        }
        out.steps.push({ label, ok: true, wheels: times });
      } else if (step.cdp) {
        const r = await cdp.send(step.cdp, step.params || {});
        out.steps.push({ label, ok: true, cdp: step.cdp });
      } else if (step.shot) {
        const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const p = path.resolve(baseDir, step.shot);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
        out.steps.push({ label, shot: step.shot });
      }
    } catch (e) {
      out.steps.push({ label, error: String(e.message || e) });
      if (step.required) break;
    }
  }

  out.logs = cdp.logs.slice(-40);
  console.log(JSON.stringify(out, null, 1));
  try { cdp.ws.close(); } catch {}
  try { await fetch(`http://127.0.0.1:${PORT}/json/close/${page.id}`); } catch {}
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
