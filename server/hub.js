'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const { T } = require('../lib/protocol');
const { Session } = require('../lib/session');

class AgentSession extends Session {
  constructor(hub, socket) {
    super(socket);
    this.hub = hub;
    this.client = null;
    this.connectedAt = null;
  }

  onMessage(type, body) {
    this.hub.handleAgentFrame(this, type, body);
  }

  onClosed() {
    this.hub.onSessionClosed(this);
  }
}

class Hub extends EventEmitter {
  constructor(store, log) {
    super();
    this.store = store;
    this.log = log;
    this.sessions = new Map(); // clientId -> AgentSession
    this.listeners = new Map(); // tunId -> {server}
    this.busyPorts = new Map(); // port -> tunId
    this.hostTunnels = new Map(); // host -> tunId
    this.sidCounter = 1;
    this.startedAt = Date.now();
    this.agentServer = null;
    this.vhostServer = null;
  }

  start() {
    const s = this.store.data.settings;
    this.startAgentServer(s.agentPort);
    if (s.vhostPort > 0) this.startVhost(s.vhostPort);
    for (const t of this.store.data.tunnels) {
      if (t.enabled) this.startTunnel(t);
    }
    this.pingTimer = setInterval(() => this.pingAll(), 15000);
  }

  stop() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const s of Array.from(this.sessions.values())) s.close();
    for (const id of Array.from(this.listeners.keys())) this.stopTunnel(id);
    if (this.agentServer) this.agentServer.close();
    if (this.vhostServer) this.vhostServer.close();
  }

  nextSid() {
    const sid = this.sidCounter;
    this.sidCounter = (this.sidCounter + 1) >>> 0;
    return sid;
  }

  startAgentServer(port) {
    this.agentServer = net.createServer((socket) => {
      // 等待 HELLO 认证，会话先挂起
      new AgentSession(this, socket);
    });
    this.agentServer.on('error', (err) => this.log('error', `控制端口监听失败: ${err.message}`));
    this.agentServer.listen(port, '0.0.0.0', () => {
      this.log('info', `agent 控制端口已监听: ${port}`);
      this.emit('change');
    });
  }

  startVhost(port) {
    this.vhostServer = net.createServer((conn) => this.handleVhostConn(conn));
    this.vhostServer.on('error', (err) => this.log('error', `HTTP 域名端口监听失败: ${err.message}`));
    this.vhostServer.listen(port, '0.0.0.0', () => {
      this.log('info', `HTTP 域名端口已监听: ${port}`);
    });
  }

  handleVhostConn(conn) {
    let buf = Buffer.alloc(0);
    let settled = false;
    const reject = (code, text) => {
      if (settled) return;
      settled = true;
      const body = `${text}\n`;
      conn.write(
        `HTTP/1.1 ${code} ${text}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
      );
      conn.destroy();
    };
    const onData = (chunk) => {
      if (settled) return;
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) {
        if (buf.length > 32 * 1024) reject(400, 'Bad Request');
        return;
      }
      conn.removeListener('data', onData);
      const head = buf.subarray(0, idx).toString('latin1');
      const m = /^Host:\s*([^\r\n]+)/im.exec(head);
      if (!m) return reject(400, 'Bad Request');
      const host = m[1].trim().toLowerCase().replace(/:\d+$/, '');
      const tunId = this.hostTunnels.get(host);
      const tunnel = tunId ? this.store.getTunnel(tunId) : null;
      if (!tunnel || !tunnel.enabled) return reject(404, '未找到匹配的域名隧道');
      const session = this.sessions.get(tunnel.clientId);
      if (!session || session.closed) return reject(502, '客户端不在线');
      settled = true;
      // 改写为 Connection: close，确保每条连接只服务一个请求，后续请求重新按 Host 路由
      const lines = head.split('\r\n');
      let found = false;
      for (let i = 1; i < lines.length; i++) {
        if (/^connection\s*:/i.test(lines[i])) {
          lines[i] = 'Connection: close';
          found = true;
          break;
        }
      }
      let newHead = lines.join('\r\n');
      if (!found) newHead += '\r\nConnection: close';
      newHead += '\r\n\r\n';
      buf = Buffer.concat([Buffer.from(newHead, 'latin1'), buf.subarray(idx + 4)]);
      this.acceptConnection(tunnel, conn, buf);
    };
    conn.on('data', onData);
    conn.on('error', () => {});
  }

  handleAgentFrame(session, type, body) {
    switch (type) {
      case T.HELLO: {
        if (session.client) return;
        let msg;
        try {
          msg = JSON.parse(body.toString('utf8'));
        } catch {
          msg = {};
        }
        const client = this.store.getClientByToken(msg.token || '');
        if (!client) {
          session.send(T.ERROR, { code: 'AUTH_FAILED', msg: 'token 无效' });
          session.close();
          return;
        }
        if (!client.enabled) {
          session.send(T.ERROR, { code: 'DISABLED', msg: '客户端已被禁用' });
          session.close();
          return;
        }
        const old = this.sessions.get(client.id);
        session.client = client;
        session.connectedAt = new Date().toISOString();
        client.lastSeen = session.connectedAt;
        this.store.save();
        this.sessions.set(client.id, session);
        if (old && old !== session) old.close();
        this.log('info', `客户端上线: ${client.name} (${client.id})`);
        session.send(T.HELLO_OK, { id: client.id, name: client.name });
        this.syncTunnels(session);
        this.emit('change');
        break;
      }
      case T.OPEN_OK:
      case T.OPEN_ERR: {
        let msg;
        try {
          msg = JSON.parse(body.toString('utf8'));
        } catch {
          msg = {};
        }
        const st = session.streams.get(msg.sid);
        if (!st) return;
        if (st.timer) {
          clearTimeout(st.timer);
          st.timer = null;
        }
        if (type === T.OPEN_ERR) {
          this.log('warn', `隧道 ${st.tunnel ? st.tunnel.name : '?'} 连接本地服务失败: ${msg.err || 'unknown'}`);
          session.closeStream(st.sid);
          return;
        }
        st.opened = true;
        const sock = st.pendingSocket;
        if (sock) {
          session.attach(st.sid, sock);
          sock.resume();
        }
        if (st.buffered) {
          session.writeData(st.sid, st.buffered);
          st.buffered = null;
        }
        break;
      }
      case T.PING:
        session.send(T.PONG);
        break;
      case T.STATE:
        break;
      default:
        break;
    }
  }

  onSessionClosed(session) {
    if (!session.client) return;
    if (this.sessions.get(session.client.id) === session) {
      this.sessions.delete(session.client.id);
      this.log('info', `客户端离线: ${session.client.name} (${session.client.id})`);
      this.emit('change');
    }
  }

  syncTunnels(session) {
    const tunnels = this.store.data.tunnels.filter((t) => t.clientId === session.client.id && t.enabled);
    const list = tunnels.map((t) => ({
      id: t.id,
      type: t.type,
      localAddr: t.localAddr,
      localPort: t.localPort,
      host: t.host || null,
    }));
    session.send(T.SYNC, { tunnels: list });
  }

  pingAll() {
    for (const session of Array.from(this.sessions.values())) {
      if (Date.now() - session.lastActive > 60 * 1000) {
        session.close();
      } else {
        session.send(T.PING);
      }
    }
  }

  startTunnel(t) {
    if (this.listeners.has(t.id)) return;
    if (t.type === 'http') {
      const host = (t.host || '').toLowerCase();
      if (!host) {
        this.log('warn', `HTTP 隧道 ${t.name} 缺少域名，未启动`);
        return;
      }
      const conflict = this.store.data.tunnels.some(
        (x) => x.id !== t.id && x.enabled && x.type === 'http' && (x.host || '').toLowerCase() === host
      );
      if (conflict) {
        this.log('warn', `HTTP 隧道 ${t.name} 域名 ${host} 已存在，未启动`);
        return;
      }
      this.hostTunnels.set(host, t.id);
      this.listeners.set(t.id, { server: null });
      this.log('info', `HTTP 隧道启动: ${t.name} -> ${host}@${t.localAddr}:${t.localPort}`);
      this.emit('change');
      return;
    }
    if (!t.remotePort) return;
    if (this.busyPorts.has(t.remotePort)) {
      this.log('warn', `隧道 ${t.name} 端口 ${t.remotePort} 已被占用，未启动`);
      return;
    }
    const srv = net.createServer((conn) => this.acceptConnection(t, conn));
    srv.on('error', (err) => {
      this.log('error', `隧道 ${t.name} 监听 ${t.remotePort} 失败: ${err.message}`);
      this.listeners.delete(t.id);
      this.busyPorts.delete(t.remotePort);
      this.emit('change');
    });
    srv.listen(t.remotePort, '0.0.0.0', () => {
      this.listeners.set(t.id, { server: srv });
      this.busyPorts.set(t.remotePort, t.id);
      this.log('info', `TCP 隧道启动: ${t.name} -> 0.0.0.0:${t.remotePort} => ${t.localAddr}:${t.localPort}`);
      this.emit('change');
    });
  }

  stopTunnel(id) {
    const ent = this.listeners.get(id);
    if (!ent) return;
    this.listeners.delete(id);
    if (ent.server) {
      ent.server.close();
      for (const port of Array.from(this.busyPorts.keys())) {
        if (this.busyPorts.get(port) === id) this.busyPorts.delete(port);
      }
    } else {
      const t = this.store.getTunnel(id);
      if (t && t.host) this.hostTunnels.delete(t.host.toLowerCase());
    }
    const t = this.store.getTunnel(id);
    if (t) {
      const session = this.sessions.get(t.clientId);
      if (session) {
        for (const st of Array.from(session.streams.values())) {
          if (st.tunnel && st.tunnel.id === id) session.closeStream(st.sid);
        }
      }
      this.log('info', `隧道已停止: ${t.name}`);
    }
    this.emit('change');
  }

  applyTunnelChange(t) {
    const running = this.listeners.has(t.id);
    if (!t.enabled) {
      if (running) this.stopTunnel(t.id);
      return;
    }
    if (running) this.stopTunnel(t.id);
    this.startTunnel(t);
    const session = this.sessions.get(t.clientId);
    if (session) this.syncTunnels(session);
  }

  acceptConnection(tunnel, conn, initialBuf) {
    const session = this.sessions.get(tunnel.clientId);
    if (!session || session.closed) {
      conn.destroy();
      return;
    }
    const sid = this.nextSid();
    const st = session.createStream(sid, tunnel);
    st.pendingSocket = conn;
    st.buffered = initialBuf || null;
    conn.pause();
    st.timer = setTimeout(() => {
      this.log('warn', `隧道 ${tunnel.name} 连接本地服务超时，已断开`);
      session.closeStream(sid);
    }, 10 * 1000);
    session.send(T.OPEN, {
      sid,
      tunId: tunnel.id,
      type: tunnel.type,
      dst: `${tunnel.localAddr}:${tunnel.localPort}`,
    });
  }

  findFreePort(start, end) {
    for (let p = start; p <= end; p++) {
      if (!this.busyPorts.has(p)) return p;
    }
    return null;
  }

  snapshot() {
    const clients = this.store.data.clients.map((c) => {
      const s = this.sessions.get(c.id);
      const conns = s ? Array.from(s.connsByTunnel.values()).reduce((a, b) => a + b, 0) : 0;
      return {
        id: c.id,
        name: c.name,
        remark: c.remark,
        enabled: c.enabled,
        createdAt: c.createdAt,
        lastSeen: s ? s.connectedAt : c.lastSeen,
        online: !!s,
        conns,
      };
    });
    const tunnels = this.store.data.tunnels.map((t) => {
      const s = this.sessions.get(t.clientId);
      const conns = s ? s.connsByTunnel.get(t.id) || 0 : 0;
      const running =
        this.listeners.has(t.id) ||
        (t.type === 'http' && !!t.host && this.hostTunnels.get(t.host.toLowerCase()) === t.id);
      return { ...t, running, online: !!s, conns };
    });
    const onlineClients = clients.filter((c) => c.online).length;
    const totalConns = clients.reduce((a, c) => a + c.conns, 0);
    return { clients, tunnels, onlineClients, totalConns, startedAt: this.startedAt };
  }
}

module.exports = { Hub };
