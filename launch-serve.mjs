// 以脱离父进程的方式拉起更新源服务（父进程退出后仍然存活）
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(here, 'serve.mjs')], {
  cwd: here,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
child.unref();
console.log('spawned serve.mjs pid=' + child.pid + ' detached=' + child.spawnargs.length);
