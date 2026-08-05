'use strict';

const fs = require('fs');
const path = require('path');
const { genId, genToken, hashPassword } = require('./util');

const LOG_LIMIT = 500;

function defaults() {
  const nowIso = new Date().toISOString();
  return {
    version: 1,
    createdAt: nowIso,
    settings: {
      panelPort: 8080,
      agentPort: 9000,
      vhostPort: 8090,
      tunnelPortStart: 20000,
      tunnelPortEnd: 29999,
      panelUser: 'admin',
      panelPass: hashPassword('admin123'), // 首次启动默认密码，登录后请修改
      sessionSecret: genToken(32),
    },
    clients: [],
    tunnels: [],
    logs: [],
  };
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = null;
    this.saveTimer = null;
    this.created = false;
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) this.created = true;
      const raw = fs.readFileSync(this.file, 'utf8');
      this.data = JSON.parse(raw);
      if (!this.data.settings) this.data.settings = defaults().settings;
      if (!this.data.clients) this.data.clients = [];
      if (!this.data.tunnels) this.data.tunnels = [];
      if (!this.data.logs) this.data.logs = [];
    } catch (err) {
      this.data = defaults();
      this.save();
    }
  }

  save(immediate = false) {
    if (this.saveTimer && !immediate) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    const doSave = () => {
      this.saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
        fs.renameSync(tmp, this.file);
      } catch (err) {
        console.error('[store] 保存失败:', err.message);
      }
    };
    if (immediate) doSave();
    else this.saveTimer = setTimeout(doSave, 200);
  }

  addLog(level, msg) {
    const entry = { ts: new Date().toISOString(), level, msg };
    this.data.logs.push(entry);
    if (this.data.logs.length > LOG_LIMIT) this.data.logs.splice(0, this.data.logs.length - LOG_LIMIT);
    this.save();
    return entry;
  }

  getClient(id) {
    return this.data.clients.find((c) => c.id === id);
  }

  getClientByToken(token) {
    return this.data.clients.find((c) => c.token === token);
  }

  addClient(name, remark) {
    const c = {
      id: 'c_' + genId(10),
      name: name || '未命名客户端',
      token: genToken(32),
      remark: remark || '',
      enabled: true,
      createdAt: new Date().toISOString(),
      lastSeen: null,
    };
    this.data.clients.push(c);
    this.save();
    return c;
  }

  getTunnel(id) {
    return this.data.tunnels.find((t) => t.id === id);
  }

  addTunnel(t) {
    const tunnel = {
      id: 't_' + genId(10),
      name: t.name || '未命名隧道',
      type: t.type === 'http' ? 'http' : 'tcp',
      clientId: t.clientId,
      localAddr: t.localAddr || '127.0.0.1',
      localPort: parseInt(t.localPort, 10) || 80,
      remotePort: t.type === 'http' ? null : parseInt(t.remotePort, 10) || null,
      host: t.type === 'http' ? (t.host || '').trim() : null,
      enabled: t.enabled !== false,
      createdAt: new Date().toISOString(),
    };
    this.data.tunnels.push(tunnel);
    this.save();
    return tunnel;
  }

  updateTunnel(id, patch) {
    const t = this.getTunnel(id);
    if (!t) return null;
    if (patch.name != null) t.name = patch.name;
    if (patch.localAddr != null) t.localAddr = patch.localAddr;
    if (patch.localPort != null) t.localPort = parseInt(patch.localPort, 10);
    if (patch.host != null) t.host = patch.host.trim();
    if (patch.remotePort != null) t.remotePort = parseInt(patch.remotePort, 10) || null;
    if (patch.enabled != null) t.enabled = !!patch.enabled;
    this.save();
    return t;
  }

  removeClient(id) {
    const idx = this.data.clients.findIndex((c) => c.id === id);
    if (idx < 0) return false;
    this.data.clients.splice(idx, 1);
    this.data.tunnels = this.data.tunnels.filter((t) => t.clientId !== id);
    this.save();
    return true;
  }

  removeTunnel(id) {
    const idx = this.data.tunnels.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    this.data.tunnels.splice(idx, 1);
    this.save();
    return true;
  }
}

module.exports = { Store, defaults };
