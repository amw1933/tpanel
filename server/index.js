#!/usr/bin/env node
'use strict';

const path = require('path');
const { Store } = require('../lib/store');
const { Hub } = require('./hub');
const { createApp } = require('./api');

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val != null && !val.startsWith('--')) {
        opts[key] = val;
        i++;
      } else {
        opts[key] = true;
      }
    }
  }
  return opts;
}

const args = parseArgs(process.argv.slice(2));
const dataDir = path.resolve(args.data || process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const store = new Store(path.join(dataDir, 'panel.json'));
const settings = store.data.settings;

// 首次启动可用环境变量初始化
if (store.created) {
  if (process.env.PANEL_PORT) settings.panelPort = parseInt(process.env.PANEL_PORT, 10) || settings.panelPort;
  if (process.env.AGENT_PORT) settings.agentPort = parseInt(process.env.AGENT_PORT, 10) || settings.agentPort;
  if (process.env.VHOST_PORT != null) settings.vhostPort = parseInt(process.env.VHOST_PORT, 10) || settings.vhostPort;
  if (process.env.PANEL_USER) settings.panelUser = process.env.PANEL_USER;
  if (process.env.PANEL_PASSWORD) settings.panelPass = require('../lib/util').hashPassword(process.env.PANEL_PASSWORD);
  if (process.env.TUNNEL_PORT_START) settings.tunnelPortStart = parseInt(process.env.TUNNEL_PORT_START, 10);
  if (process.env.TUNNEL_PORT_END) settings.tunnelPortEnd = parseInt(process.env.TUNNEL_PORT_END, 10);
  store.save(true);
}

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  if (level === 'error') console.error(line);
  else console.log(line);
  try {
    store.addLog(level, msg);
  } catch {}
}

const hub = new Hub(store, log);
hub.start();

const app = createApp({ store, hub, log });
app.on('error', (err) => log('error', `面板服务异常: ${err.message}`));
app.listen(settings.panelPort, '0.0.0.0', () => {
  log('info', `========================================`);
  log('info', `内网穿透面板已启动`);
  log('info', `  面板地址:  http://0.0.0.0:${settings.panelPort}`);
  log('info', `  agent 端口: ${settings.agentPort}`);
  log('info', `  HTTP 域名端口: ${settings.vhostPort}`);
  log('info', `========================================`);
  if (store.created) {
    log('warn', `首次启动，默认账号: ${settings.panelUser} / admin123，请登录后立即修改密码`);
  }
});

function shutdown() {
  log('info', '正在关闭...');
  hub.stop();
  app.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
