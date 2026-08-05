// 端到端自测：在一个进程内启动 服务端 + 演示服务 + agent，验证 TCP/HTTP 隧道
// 用法: node scripts/e2e-test.js
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tpanel-e2e-'));
const PANEL_BASE = 'http://127.0.0.1:18080';
const AGENT_PORT = 19000;
const VHOST_PORT = 18090;
const DEMO_PORT = 19100;

const children = [];

function spawnNode(script, args, env) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[${path.basename(script)}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${path.basename(script)}!] ${d}`));
  children.push(child);
  return child;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs, desc) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(400);
  }
  throw new Error(`等待超时: ${desc}${lastErr ? ` (${lastErr.message})` : ''}`);
}

async function api(pathname, opts = {}) {
  const res = await fetch(`${PANEL_BASE}${pathname}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${pathname} -> ${res.status}: ${data.error || 'unknown'}`);
  return data;
}

function httpGet(port, pathname, hostHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, agent: false, headers: hostHeader ? { Host: hostHeader } : {} },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${name}${extra ? ` -> ${extra}` : ''}`);
  }
}

async function main() {
  console.log('== 启动服务端 / 演示服务 ==');
  spawnNode('server/index.js', [], {
    PANEL_PORT: '18080',
    AGENT_PORT: String(AGENT_PORT),
    VHOST_PORT: String(VHOST_PORT),
    TUNNEL_PORT_START: '21000',
    TUNNEL_PORT_END: '21020',
    DATA_DIR: TMP,
  });
  spawnNode('scripts/demo.js', [String(DEMO_PORT)]);

  await waitFor(async () => {
    const r = await fetch(`${PANEL_BASE}/api/health`);
    return r.ok;
  }, 15000, '服务端就绪');
  console.log('  服务端已就绪');

  console.log('== 登录 & 创建客户端 ==');
  const login = await api('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  check('面板登录', !!login.token);
  const token = login.token;
  const client = await api('/api/clients', { method: 'POST', token, body: { name: 'e2e客户端' } });
  check('创建客户端', !!client.id && !!client.token);

  console.log('== 启动 agent ==');
  const agentProc = spawnNode('agent/index.js', ['--server', `127.0.0.1:${AGENT_PORT}`, '--token', client.token]);
  await waitFor(async () => {
    const clients = await api('/api/clients', { token });
    return clients.find((c) => c.id === client.id && c.online);
  }, 15000, 'agent 上线');
  console.log('  agent 已上线');

  console.log('== TCP 隧道测试 ==');
  const tcpTun = await api('/api/tunnels', {
    method: 'POST',
    token,
    body: { name: 'e2e-tcp', type: 'tcp', clientId: client.id, localAddr: '127.0.0.1', localPort: DEMO_PORT },
  });
  check('创建 TCP 隧道并自动分配端口', tcpTun.remotePort >= 21000, `remotePort=${tcpTun.remotePort}`);
  await waitFor(async () => (await api('/api/tunnels', { token })).find((t) => t.id === tcpTun.id).running, 10000, '隧道监听启动');
  await waitFor(async () => (await api('/api/tunnels', { token })).find((t) => t.id === tcpTun.id).online, 10000, '隧道在线');
  const tcpRes = await httpGet(tcpTun.remotePort, '/hello');
  check('TCP 隧道访问内网服务', tcpRes.status === 200 && tcpRes.body.includes('内网服务已连通'), `status=${tcpRes.status}`);

  console.log('== HTTP 域名隧道测试 ==');
  const httpTun = await api('/api/tunnels', {
    method: 'POST',
    token,
    body: { name: 'e2e-http', type: 'http', clientId: client.id, localAddr: '127.0.0.1', localPort: DEMO_PORT, host: 'e2e.local' },
  });
  check('创建 HTTP 隧道', httpTun.running && httpTun.type === 'http');
  const vhostRes = await httpGet(VHOST_PORT, '/', 'e2e.local');
  check('HTTP 域名隧道按 Host 路由', vhostRes.status === 200 && vhostRes.body.includes('内网服务已连通'), `status=${vhostRes.status}`);
  const missRes = await httpGet(VHOST_PORT, '/', 'nope.local');
  check('未知域名返回 404', missRes.status === 404, `status=${missRes.status}`);

  console.log('== 概览 / 日志 ==');
  const overview = await api('/api/overview', { token });
  check('概览统计正确', overview.clients.length === 1 && overview.onlineClients === 1 && overview.totalConns === 0);
  const logs = await api('/api/logs?limit=20', { token });
  check('日志可读', logs.length > 0);

  console.log('== agent 断线重连测试 ==');
  agentProc.kill();
  await waitFor(async () => {
    const clients = await api('/api/clients', { token });
    return !clients.find((c) => c.id === client.id).online;
  }, 10000, 'agent 离线');
  spawnNode('agent/index.js', ['--server', `127.0.0.1:${AGENT_PORT}`, '--token', client.token]);
  await waitFor(async () => {
    const clients = await api('/api/clients', { token });
    return clients.find((c) => c.id === client.id && c.online);
  }, 15000, 'agent 重连上线');
  const tcpRes2 = await httpGet(tcpTun.remotePort, '/again');
  check('重连后隧道恢复可用', tcpRes2.status === 200 && tcpRes2.body.includes('内网服务已连通'), `status=${tcpRes2.status}`);

  console.log('== 删除隧道测试 ==');
  await api(`/api/tunnels/${tcpTun.id}`, { method: 'DELETE', token });
  await waitFor(async () => !(await api('/api/tunnels', { token })).find((t) => t.id === tcpTun.id), 10000, '隧道已删除');
  let portClosed = false;
  try {
    await httpGet(tcpTun.remotePort, '/');
  } catch (e) {
    portClosed = e.code === 'ECONNREFUSED';
  }
  check('删除隧道后端口不再监听', portClosed);

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((err) => {
    console.error('\n测试异常:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    console.log('== 清理子进程 ==');
    for (const c of children) {
      try {
        c.kill();
      } catch {}
    }
    setTimeout(() => process.exit(), 800);
  });
