// 极简 CDP 客户端：连接本地 headless Edge，注入脚本文本，导航、求值、截图
import fs from 'node:fs';
import path from 'node:path';

export const PORT = process.env.FZ_CDP_PORT || 9333;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function newPage() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
  if (!r.ok) throw new Error('无法新建标签页，headless Edge 没起来？');
  return r.json();
}

export async function closePage(id) {
  try { await fetch(`http://127.0.0.1:${PORT}/json/close/${id}`); } catch {}
}

export class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    this.errors = [];
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', (e) => rej(new Error('ws error')));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const a = (msg.params.args || []).map((x) => x.value ?? x.description ?? x.type);
        const line = '[' + msg.params.type + '] ' + a.join(' ');
        this.logs.push(line);
        if (msg.params.type === 'error' && /fishy/.test(line)) this.errors.push(line);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        const t = d.exception?.description || d.text;
        this.logs.push('[exception] ' + t);
        if (/fishy/.test(t || '')) this.errors.push(t);
      }
    });
  }
  send(method, params = {}, timeout = 60000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); }
      }, timeout);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async navigate(url, waitMs = 0) {
    const loaded = new Promise((res) => {
      const t = setTimeout(res, 25000);
      const h = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.method === 'Page.loadEventFired') { clearTimeout(t); this.ws.removeEventListener('message', h); res(); }
        } catch {}
      };
      this.ws.addEventListener('message', h);
    });
    await this.send('Page.navigate', { url });
    await loaded;
    if (waitMs) await sleep(waitMs);
  }
  async shot(outPath) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const p = path.resolve(outPath);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  }
  close() { try { this.ws.close(); } catch {} }
}

// 打开一个页面并完成基础设置（UA、视口、注入脚本）
export async function openInjected(scriptPaths = [], baseDir = process.cwd()) {
  const page = await newPage();
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0',
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  for (const f of scriptPaths) {
    const src = fs.readFileSync(path.resolve(baseDir, f), 'utf8');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
  }
  return { page, cdp };
}
