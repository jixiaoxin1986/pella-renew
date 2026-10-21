#!/usr/bin/env node
/**
 * 代理选择 + 超时控制器（结构对齐 katabump-renew 的 proxy_runner.js）
 * - 可选 Secret WEBSHARE_PROXY_LIST_URL：下载代理列表（IP:PORT:USER:PASS 每行一条），
 *   随机选一条作为 Playwright 出口（住宅出口更易通过广告页的人机验证）。
 *   未配置则直连（KataBump 现行配置即直连且已成功，Pella 默认也直连）。
 * - 子进程超时（ACTION_TIMEOUT_MINUTES，默认 20 分钟）：先 SIGTERM 整个进程组，
 *   宽限 12 秒后 SIGKILL，退出码透传。
 */

const { spawn } = require('child_process');

async function pickProxy() {
  const url = process.env.WEBSHARE_PROXY_LIST_URL;
  if (!url) {
    console.log('[proxy-runner] 未配置 WEBSHARE_PROXY_LIST_URL，直连运行');
    return;
  }
  try {
    const res = await fetch(url);
    const text = await res.text();
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    console.log(`[proxy-runner] 代理列表已下载，行数: ${lines.length}`);
    if (lines.length === 0) return;
    const line = lines[Math.floor(Math.random() * lines.length)];
    const parts = line.split(':');
    if (parts.length >= 2) {
      const [host, port, user, pass] = parts;
      process.env.PROXY_SERVER = `http://${host}:${port}`;
      if (user) process.env.PROXY_USER = user;
      if (pass) process.env.PROXY_PASS = pass;
      console.log(`[proxy-runner] 选择代理: ${host}:${port}`);
    } else {
      console.log('[proxy-runner] 代理行格式不符，忽略:', line.slice(0, 20));
    }
  } catch (e) {
    console.log('[proxy-runner] 代理列表下载失败，直连运行:', e.message);
  }
}

async function main() {
  await pickProxy();
  const timeoutMin = parseInt(process.env.ACTION_TIMEOUT_MINUTES || '20', 10);
  console.log(`[proxy-runner] 启动 action_renew.js，超时=${timeoutMin} 分钟，SIGTERM 宽限=12 秒...`);
  const child = spawn('node', ['action_renew.js'], {
    stdio: 'inherit',
    env: process.env,
    detached: true,
  });

  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    console.log('[proxy-runner] 子进程超时，先 SIGTERM 进程组');
    try { process.kill(-child.pid, 'SIGTERM'); } catch (e) {}
    setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (e) {}
    }, 12000);
  }, timeoutMin * 60 * 1000);

  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    if (killed) {
      console.log('[proxy-runner] 子进程因超时被终止');
      process.exit(124);
    }
    process.exit(code !== null ? code : 1);
  });
}

main().catch((e) => {
  console.error('[proxy-runner] FATAL:', e);
  process.exit(1);
});
