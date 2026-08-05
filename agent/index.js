#!/usr/bin/env node
'use strict';

const net = require('net');
const { T } = require('../lib/protocol');
const { Session } = require('../lib/session');

class AgentSession extends Session {
  constructor(socket, agent) {
    super(socket);
    this.agent = agent;
  }

  onMessage(type, body) {
    this.agent.handleMessage(this, type, body);
  }

  onClosed() {
    this.agent.onSessionClosed(this);
  }
}

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

class Agent {
  constructor(opts) {
    this.server = opts.server || process.env.AGENT_SERVER || '127.0.0.1:9000';
    this.token = opts.token || process.env.AGENT_TOKEN || '';
    this.name = opts.name || process.env.AGENT_NAME || '';
    this.backoff = 1000;
    this.stopped = false;
    this.session = null;
    this.reconnectTimer = null;
    if (!this.token) {
      console.error('[agent] 缺少 token，请通过 --token 或 AGENT_TOKEN 环境变量指定');
      process.exit(1);
    }
  }

  log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
  }

  run() {
    this.log(`TunnelPanel agent 启动，目标服务器: ${this.server}`);
    this.connect();
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.session) this.session.close();
    this.log('agent 已退出');
    process.exit(0);
  }

  connect() {
    if (this.stopped) return;
    const m = this.server.match(/^\[?([^\]]+)\]?:(\d+)$/);
    const host = m ? m[1] : this.server;
    const port = m ? parseInt(m[2], 10) : 9000;
    this.log(`连接服务器 ${host}:${port} ...`);
    const socket = net.connect(port, host);
    const session = new AgentSession(socket, this);
    this.session = session;

    socket.on('connect', () => {
      this.backoff = 1000;
      this.log('已连接，正在认证...');
      session.send(T.HELLO, { token: this.token, name: this.name });
    });
    socket.on('error', (err) => {
      if (err.code !== 'ECONNRESET') this.log(`连接错误: ${err.message}`);
    });
    socket.on('close', () => {
      this.session = null;
      if (this.stopped) return;
      this.log(`连接断开，${Math.round(this.backoff / 1000)} 秒后重连`);
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    });
  }

  onSessionClosed(session) {
    if (this.session === session) this.session = null;
  }

  handleMessage(session, type, body) {
    switch (type) {
      case T.HELLO_OK: {
        let msg;
        try {
          msg = JSON.parse(body.toString('utf8'));
        } catch {
          msg = {};
        }
        this.log(`认证成功: ${msg.name || msg.id}，等待隧道配置...`);
        break;
      }
      case T.ERROR: {
        let msg;
        try {
          msg = JSON.parse(body.toString('utf8'));
        } catch {
          msg = {};
        }
        this.log(`服务器拒绝连接: ${msg.msg || msg.code}`);
        this.stopped = true;
        session.close();
        setTimeout(() => process.exit(1), 500);
        break;
      }
      case T.SYNC: {
        let msg;
        try {
          msg = JSON.parse(body.toString('utf8'));
        } catch {
          msg = { tunnels: [] };
        }
        this.log(`收到 ${(msg.tunnels || []).length} 条隧道配置`);
        for (const t of msg.tunnels || []) {
          this.log(`  隧道 [${t.type}] ${t.id}: ${t.localAddr}:${t.localPort}`);
        }
        break;
      }
      case T.OPEN: {
        let msg;
        try {
          msg = JSON.parse(body.toString('utf8'));
        } catch {
          msg = {};
        }
        this.openLocal(session, msg);
        break;
      }
      case T.PING:
        session.send(T.PONG);
        break;
      default:
        break;
    }
  }

  openLocal(session, msg) {
    const sid = msg.sid;
    const dst = String(msg.dst || '');
    const m = dst.match(/^\[?([^\]]+)\]?:(\d+)$/);
    const host = m ? m[1] : dst;
    const port = m ? parseInt(m[2], 10) : 0;
    if (!port) {
      session.send(T.OPEN_ERR, { sid, err: '目标地址无效' });
      return;
    }
    const st = session.createStream(sid, null);
    const sock = net.connect(port, host);
    let attached = false;
    sock.on('connect', () => {
      attached = true;
      if (session.streams.has(sid)) {
        session.attach(sid, sock);
        session.send(T.OPEN_OK, { sid });
      }
    });
    sock.on('error', (err) => {
      if (!attached) {
        session.send(T.OPEN_ERR, { sid, err: err.message });
        session.closeStream(sid);
      }
    });
  }
}

const args = parseArgs(process.argv.slice(2));
const agent = new Agent(args);
agent.run();
