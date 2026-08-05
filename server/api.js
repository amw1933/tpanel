'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { hashPassword, verifyPassword, genToken, maskSecret, fmtTime } = require('../lib/util');

const WEB_DIR = path.join(__dirname, '..', 'web');
const SESSION_TTL = 7 * 24 * 3600 * 1000; // 7 天
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 1 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function apiErr(code, msg) {
  const e = new Error(msg);
  e.status = code;
  return e;
}

function createApp({ store, hub, log }) {
  const sessions = new Map(); // token -> {user, expire}

  function auth(req) {
    const h = req.headers.authorization || '';
    const token = h.replace(/^Bearer\s+/i, '').trim();
    if (!token) return null;
    const s = sessions.get(token);
    if (!s || s.expire < Date.now()) {
      sessions.delete(token);
      return null;
    }
    return s;
  }

  function validateTunnel(body, existingId) {
    const type = body.type === 'http' ? 'http' : 'tcp';
    const name = String(body.name || '').trim();
    if (!name) throw apiErr(400, '请填写隧道名称');
    const localAddr = String(body.localAddr || '127.0.0.1').trim();
    const localPort = parseInt(body.localPort, 10);
    if (!(localPort > 0 && localPort < 65536)) throw apiErr(400, '本地端口无效');
    const clientId = body.clientId;
    if (!store.getClient(clientId)) throw apiErr(400, '请选择有效的客户端');
    let remotePort = null;
    let host = null;
    if (type === 'tcp') {
      remotePort = body.remotePort == null || body.remotePort === '' ? null : parseInt(body.remotePort, 10);
      if (remotePort != null && !(remotePort > 0 && remotePort < 65536)) throw apiErr(400, '远程端口无效');
    } else {
      host = String(body.host || '').trim().toLowerCase().replace(/:\d+$/, '');
      if (!host) throw apiErr(400, '请填写域名');
    }
    const others = store.data.tunnels.filter((t) => t.id !== existingId);
    for (const o of others) {
      if (!o.enabled) continue;
      if (type === 'tcp' && o.type === 'tcp' && remotePort && o.remotePort === remotePort) {
        throw apiErr(409, `远程端口 ${remotePort} 已被其他隧道占用`);
      }
      if (type === 'http' && o.type === 'http' && (o.host || '').toLowerCase() === host) {
        throw apiErr(409, `域名 ${host} 已被其他隧道占用`);
      }
    }
    return { name, type, localAddr, localPort, remotePort, host, clientId };
  }

  function tunnelStatus(t) {
    const s = hub.sessions.get(t.clientId);
    return {
      ...t,
      running: hub.listeners.has(t.id) || (t.type === 'http' && !!t.host && hub.hostTunnels.get(t.host.toLowerCase()) === t.id),
      online: !!s,
      conns: s ? s.connsByTunnel.get(t.id) || 0 : 0,
    };
  }

  async function handleApi(req, res, url) {
    const p = url.pathname;
    const method = req.method;

    if (p === '/api/health') return sendJson(res, 200, { ok: true, ts: Date.now() });

    if (p === '/api/login' && method === 'POST') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { error: '请求格式错误' });
      }
      const settings = store.data.settings;
      if (body.username === settings.panelUser && verifyPassword(body.password || '', settings.panelPass)) {
        const token = genToken(32);
        sessions.set(token, { user: settings.panelUser, expire: Date.now() + SESSION_TTL });
        return sendJson(res, 200, { token, user: settings.panelUser });
      }
      return sendJson(res, 401, { error: '用户名或密码错误' });
    }

    const s = auth(req);
    if (!s) return sendJson(res, 401, { error: '未登录或登录已过期' });

    if (p === '/api/logout' && method === 'POST') {
      sessions.delete((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/overview') {
      const snap = hub.snapshot();
      return sendJson(res, 200, {
        ...snap,
        startedAt: snap.startedAt,
        settings: {
          agentPort: store.data.settings.agentPort,
          vhostPort: store.data.settings.vhostPort,
          panelPort: store.data.settings.panelPort,
          tunnelPortStart: store.data.settings.tunnelPortStart,
          tunnelPortEnd: store.data.settings.tunnelPortEnd,
        },
        version: require('../package.json').version,
      });
    }

    if (p === '/api/clients' && method === 'GET') {
      const list = store.data.clients.map((c) => {
        const s2 = hub.sessions.get(c.id);
        return {
          ...c,
          online: !!s2,
          conns: s2 ? Array.from(s2.connsByTunnel.values()).reduce((a, b) => a + b, 0) : 0,
          lastSeen: s2 ? s2.connectedAt : c.lastSeen,
        };
      });
      return sendJson(res, 200, list);
    }

    if (p === '/api/clients' && method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const c = store.addClient(body.name, body.remark);
      log('info', `新增客户端: ${c.name} (${c.id})`);
      return sendJson(res, 200, c);
    }

    let m = p.match(/^\/api\/clients\/([^/]+)$/);
    if (m && method === 'PATCH') {
      const c = store.getClient(m[1]);
      if (!c) return sendJson(res, 404, { error: '客户端不存在' });
      const body = JSON.parse(await readBody(req));
      if (body.name != null) c.name = String(body.name).trim() || c.name;
      if (body.remark != null) c.remark = String(body.remark);
      if (body.enabled != null) {
        c.enabled = !!body.enabled;
        if (!c.enabled) {
          const s2 = hub.sessions.get(c.id);
          if (s2) {
            s2.close();
            log('info', `客户端已禁用: ${c.name}`);
          }
        }
      }
      store.save();
      return sendJson(res, 200, c);
    }

    if (m && p.endsWith('/regenerate') && method === 'POST') {
      const c = store.getClient(m[1]);
      if (!c) return sendJson(res, 404, { error: '客户端不存在' });
      c.token = genToken(32);
      const s2 = hub.sessions.get(c.id);
      if (s2) s2.close(); // 强制重连使用新 token
      store.save();
      log('info', `重新生成客户端 token: ${c.name}`);
      return sendJson(res, 200, { id: c.id, token: c.token });
    }

    if (m && method === 'DELETE') {
      const c = store.getClient(m[1]);
      if (!c) return sendJson(res, 404, { error: '客户端不存在' });
      for (const t of store.data.tunnels.filter((x) => x.clientId === c.id)) hub.stopTunnel(t.id);
      store.removeClient(c.id);
      log('info', `删除客户端: ${c.name}`);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/tunnels' && method === 'GET') {
      return sendJson(res, 200, store.data.tunnels.map(tunnelStatus));
    }

    if (p === '/api/tunnels' && method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const v = validateTunnel(body, null);
      if (v.type === 'tcp' && !v.remotePort) {
        const s2 = store.data.settings;
        v.remotePort = hub.findFreePort(s2.tunnelPortStart, s2.tunnelPortEnd);
        if (!v.remotePort) return sendJson(res, 400, { error: '自动分配端口失败，端口范围已用完' });
      }
      const t = store.addTunnel(v);
      if (t.enabled) hub.applyTunnelChange(t);
      log('info', `新增隧道: ${t.name} (${t.id})`);
      return sendJson(res, 200, tunnelStatus(t));
    }

    m = p.match(/^\/api\/tunnels\/([^/]+)$/);
    if (m && method === 'PATCH') {
      const t = store.getTunnel(m[1]);
      if (!t) return sendJson(res, 404, { error: '隧道不存在' });
      const body = JSON.parse(await readBody(req));
      const v = validateTunnel({ ...t, ...body, type: t.type }, t.id);
      const wasRunning = hub.listeners.has(t.id);
      const updated = store.updateTunnel(t.id, {
        name: v.name,
        localAddr: v.localAddr,
        localPort: v.localPort,
        remotePort: v.remotePort,
        host: v.host,
        clientId: v.clientId,
        enabled: body.enabled != null ? !!body.enabled : t.enabled,
      });
      if (updated.enabled || wasRunning) hub.applyTunnelChange(updated);
      log('info', `更新隧道: ${updated.name} (${updated.id})`);
      return sendJson(res, 200, tunnelStatus(updated));
    }

    if (m && method === 'DELETE') {
      const t = store.getTunnel(m[1]);
      if (!t) return sendJson(res, 404, { error: '隧道不存在' });
      hub.stopTunnel(t.id);
      store.removeTunnel(t.id);
      log('info', `删除隧道: ${t.name}`);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/logs' && method === 'GET') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500);
      const logs = store.data.logs.slice(-limit).map((l) => ({ ...l, time: fmtTime(l.ts) }));
      return sendJson(res, 200, logs);
    }

    if (p === '/api/settings' && method === 'GET') {
      const s2 = store.data.settings;
      return sendJson(res, 200, {
        panelUser: s2.panelUser,
        panelPort: s2.panelPort,
        agentPort: s2.agentPort,
        vhostPort: s2.vhostPort,
        tunnelPortStart: s2.tunnelPortStart,
        tunnelPortEnd: s2.tunnelPortEnd,
      });
    }

    if (p === '/api/settings' && method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const s2 = store.data.settings;
      if (body.panelUser != null && String(body.panelUser).trim()) s2.panelUser = String(body.panelUser).trim();
      if (body.currentPassword != null) {
        if (!verifyPassword(body.currentPassword, s2.panelPass)) return sendJson(res, 403, { error: '当前密码错误' });
        if (body.newPassword != null) {
          if (String(body.newPassword).length < 6) return sendJson(res, 400, { error: '新密码至少 6 位' });
          s2.panelPass = hashPassword(body.newPassword);
          log('info', '面板密码已修改');
        }
      }
      const start = parseInt(body.tunnelPortStart, 10);
      const end = parseInt(body.tunnelPortEnd, 10);
      if (start > 0 && end > start && end < 65536) {
        s2.tunnelPortStart = start;
        s2.tunnelPortEnd = end;
      }
      for (const key of ['panelPort', 'agentPort', 'vhostPort']) {
        const v = parseInt(body[key], 10);
        if (v > 0 && v < 65536) s2[key] = v;
      }
      store.save();
      log('info', '设置已保存（端口修改需重启生效）');
      return sendJson(res, 200, { ok: true, restartNeeded: true });
    }

    sendJson(res, 404, { error: '接口不存在' });
  }

  function serveStatic(req, res, url) {
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(WEB_DIR, p));
    if (!file.startsWith(WEB_DIR + path.sep)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not Found');
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      });
      res.end(data);
    });
  }

  return http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400);
      return res.end('Bad Request');
    }

    if (url.pathname === '/api/events') {
      if (!auth(req)) return sendJson(res, 401, { error: '未登录' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      const onEvent = (type) => res.write(`data: ${JSON.stringify({ type })}\n\n`);
      hub.on('change', onEvent);
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(heartbeat);
        hub.removeListener('change', onEvent);
      });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((err) => {
        const code = err.status || 500;
        sendJson(res, code, { error: err.message || '服务器错误' });
        if (code >= 500) log('error', `API 错误: ${err.stack || err.message}`);
      });
      return;
    }

    serveStatic(req, res, url);
  });
}

module.exports = { createApp };
