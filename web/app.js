/* 内网穿透面板 - 前端逻辑（零依赖） */
(function () {
  'use strict';

  const state = {
    token: localStorage.getItem('tp_token') || '',
    user: localStorage.getItem('tp_user') || '',
    view: 'overview',
    overview: null,
    logs: [],
  };

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function fmtDur(ms) {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d} 天 ${h} 小时`;
    if (h > 0) return `${h} 小时 ${m} 分`;
    return `${m} 分 ${s % 60} 秒`;
  }

  async function api(path, method = 'GET', body) {
    const opts = {
      method,
      headers: {},
    };
    if (state.token) opts.headers.Authorization = `Bearer ${state.token}`;
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (res.status === 401 && path !== '/api/login') {
      logout();
      throw new Error('登录已过期');
    }
    if (!res.ok) throw new Error((data && data.error) || `请求失败 (${res.status})`);
    return data;
  }

  function toast(msg, type = 'ok') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast ${type}`;
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  function openModal(html) {
    $('#modal').innerHTML = html;
    $('#modal-mask').classList.remove('hidden');
  }

  function closeModal() {
    $('#modal-mask').classList.add('hidden');
  }

  function confirmAction(title, msg, onOk) {
    openModal(`
      <h3>${esc(title)}</h3>
      <p class="muted" style="margin-bottom:16px">${esc(msg)}</p>
      <div class="modal-foot">
        <button class="btn" onclick="window.__closeModal()">取消</button>
        <button class="btn danger" id="confirm-btn">确认删除</button>
      </div>
    `);
    $('#confirm-btn').onclick = () => {
      closeModal();
      onOk();
    };
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast('已复制到剪贴板'),
        () => fallbackCopy(text)
      );
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('已复制到剪贴板');
    } catch {
      toast('复制失败，请手动复制', 'err');
    }
    ta.remove();
  }

  /* ---------------- 登录 ---------------- */

  async function login(user, pass) {
    const data = await api('/api/login', 'POST', { username: user, password: pass });
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem('tp_token', data.token);
    localStorage.setItem('tp_user', data.user);
    enterApp();
  }

  function logout() {
    state.token = '';
    state.user = '';
    localStorage.removeItem('tp_token');
    localStorage.removeItem('tp_user');
    $('#app-view').classList.add('hidden');
    $('#login-view').classList.remove('hidden');
  }

  /* ---------------- 视图切换 ---------------- */

  const TITLES = {
    overview: '概览',
    clients: '客户端',
    tunnels: '隧道',
    logs: '日志',
    settings: '设置',
  };

  function switchView(view) {
    state.view = view;
    $('#view-title').textContent = TITLES[view] || view;
    $$('.sidebar nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
    renderView();
  }

  function renderView() {
    if (state.view === 'overview') renderOverview();
    else if (state.view === 'clients') renderClients();
    else if (state.view === 'tunnels') renderTunnels();
    else if (state.view === 'logs') renderLogs();
    else if (state.view === 'settings') renderSettings();
  }

  /* ---------------- 概览 ---------------- */

  async function loadOverview() {
    state.overview = await api('/api/overview');
    if (state.view === 'overview') renderOverview();
    $('#srv-version').textContent = `v${state.overview.version || '0.1.0'}`;
  }

  function renderOverview() {
    const o = state.overview;
    if (!o) return;
    const runningTunnels = o.tunnels.filter((t) => t.running).length;
    $('#content').innerHTML = `
      <div class="cards">
        <div class="card"><div class="label">客户端在线</div><div class="num blue">${o.onlineClients} / ${o.clients.length}</div></div>
        <div class="card"><div class="label">隧道运行</div><div class="num green">${runningTunnels} / ${o.tunnels.length}</div></div>
        <div class="card"><div class="label">当前连接数</div><div class="num orange">${o.totalConns}</div></div>
        <div class="card"><div class="label">服务运行时长</div><div class="num" style="font-size:22px">${fmtDur(Date.now() - o.startedAt)}</div></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>隧道状态</h3><button class="btn sm" onclick="window.__go('tunnels')">管理隧道</button></div>
        ${renderTunnelTable(o.tunnels.slice(0, 8), true)}
      </div>
      <div class="panel">
        <div class="panel-head"><h3>客户端状态</h3><button class="btn sm" onclick="window.__go('clients')">管理客户端</button></div>
        ${renderClientTable(o.clients.slice(0, 8), true)}
      </div>
    `;
  }

  /* ---------------- 客户端 ---------------- */

  async function loadClients() {
    return api('/api/clients');
  }

  function renderClientTable(clients, mini) {
    if (!clients.length) return `<div class="empty">还没有客户端，点击右上角“新增客户端”创建</div>`;
    return `
      <table>
        <thead><tr>
          <th>名称</th><th>状态</th><th>连接数</th><th>最后上线</th>${mini ? '' : '<th>备注</th><th>操作</th>'}
        </tr></thead>
        <tbody>
          ${clients
            .map(
              (c) => `
            <tr>
              <td><strong>${esc(c.name)}</strong>${mini ? `<div class="muted mono" style="font-size:11px">${esc(c.id)}</div>` : ''}</td>
              <td>${c.online ? '<span class="badge on">在线</span>' : '<span class="badge off">离线</span>'}${c.enabled ? '' : ' <span class="badge warn">已禁用</span>'}</td>
              <td>${c.conns}</td>
              <td class="muted">${fmtTime(c.lastSeen)}</td>
              ${mini ? '' : `<td class="muted">${esc(c.remark || '-')}</td>
              <td><div class="actions">
                <button class="btn sm" onclick="window.__editClient('${c.id}')">编辑</button>
                <button class="btn sm" onclick="window.__copyClientToken('${c.id}')">复制Token</button>
                <button class="btn sm" onclick="window.__toggleClient('${c.id}')">${c.enabled ? '禁用' : '启用'}</button>
                <button class="btn sm danger" onclick="window.__delClient('${c.id}')">删除</button>
              </div></td>`}
            </tr>`
            )
            .join('')}
        </tbody>
      </table>`;
  }

  async function renderClients() {
    const clients = await loadClients();
    $('#content').innerHTML = `
      <div class="panel">
        <div class="panel-head">
          <h3>客户端列表（${clients.length}）</h3>
          <button class="btn primary" onclick="window.__newClient()">+ 新增客户端</button>
        </div>
        ${renderClientTable(clients, false)}
      </div>
    `;
  }

  function clientModal(c) {
    openModal(`
      <h3>${c ? '编辑客户端' : '新增客户端'}</h3>
      ${c ? `<div class="modal-tip">客户端 ID：<span class="mono">${esc(c.id)}</span></div>` : ''}
      <div class="form-row"><label>名称</label><input id="f-name" value="${esc(c ? c.name : '')}" placeholder="例如：家里NAS" /></div>
      <div class="form-row"><label>备注</label><textarea id="f-remark" rows="2" placeholder="选填">${esc(c ? c.remark : '')}</textarea></div>
      <div class="modal-foot">
        <button class="btn" onclick="window.__closeModal()">取消</button>
        <button class="btn primary" id="save-client">保存</button>
      </div>
    `);
    $('#save-client').onclick = async () => {
      const body = { name: $('#f-name').value, remark: $('#f-remark').value };
      try {
        if (c) await api(`/api/clients/${c.id}`, 'PATCH', body);
        else await api('/api/clients', 'POST', body);
        toast(c ? '客户端已更新' : '客户端已创建');
        closeModal();
        await refreshAll();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  }

  window.__newClient = () => clientModal(null);
  window.__editClient = async (id) => {
    const clients = await loadClients();
    clientModal(clients.find((c) => c.id === id));
  };
  window.__copyClientToken = async (id) => {
    const clients = await loadClients();
    const c = clients.find((x) => x.id === id);
    if (c) copyText(c.token);
  };
  window.__toggleClient = async (id) => {
    const clients = await loadClients();
    const c = clients.find((x) => x.id === id);
    try {
      await api(`/api/clients/${id}`, 'PATCH', { enabled: !c.enabled });
      toast(c.enabled ? '客户端已禁用' : '客户端已启用');
      await refreshAll();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  window.__delClient = (id) => {
    confirmAction('删除客户端', '将同时删除该客户端的全部隧道，且无法恢复。确定删除？', async () => {
      try {
        await api(`/api/clients/${id}`, 'DELETE');
        toast('客户端已删除');
        await refreshAll();
      } catch (e) {
        toast(e.message, 'err');
      }
    });
  };

  /* ---------------- 隧道 ---------------- */

  async function loadTunnels() {
    return api('/api/tunnels');
  }

  function tunnelBadge(t) {
    const typeBadge = `<span class="badge ${t.type}">${t.type === 'http' ? 'HTTP' : 'TCP'}</span>`;
    const statusBadge = t.running
      ? t.online
        ? '<span class="badge on">运行中</span>'
        : '<span class="badge warn">等待客户端</span>'
      : '<span class="badge off">已停止</span>';
    return `${typeBadge} ${statusBadge}`;
  }

  function tunnelTarget(t) {
    return t.type === 'http'
      ? `${esc(t.host)} -> ${esc(t.localAddr)}:${t.localPort}`
      : `0.0.0.0:${t.remotePort} -> ${esc(t.localAddr)}:${t.localPort}`;
  }

  function renderTunnelTable(tunnels, mini) {
    if (!tunnels.length) return `<div class="empty">还没有隧道，点击右上角“新增隧道”创建</div>`;
    return `
      <table>
        <thead><tr><th>名称</th><th>类型 / 状态</th><th>转发关系</th><th>连接数</th>${mini ? '' : '<th>操作</th>'}</tr></thead>
        <tbody>
          ${tunnels
            .map(
              (t) => `
            <tr>
              <td><strong>${esc(t.name)}</strong></td>
              <td>${tunnelBadge(t)}</td>
              <td class="mono">${tunnelTarget(t)}</td>
              <td>${t.conns}</td>
              ${mini ? '' : `<td><div class="actions">
                <button class="btn sm" onclick="window.__editTunnel('${t.id}')">编辑</button>
                <button class="btn sm" onclick="window.__toggleTunnel('${t.id}')">${t.enabled ? '停用' : '启用'}</button>
                <button class="btn sm danger" onclick="window.__delTunnel('${t.id}')">删除</button>
              </div></td>`}
            </tr>`
            )
            .join('')}
        </tbody>
      </table>`;
  }

  async function renderTunnels() {
    const [tunnels, clients] = await Promise.all([loadTunnels(), loadClients()]);
    state.clients = clients;
    $('#content').innerHTML = `
      <div class="panel">
        <div class="panel-head">
          <h3>隧道列表（${tunnels.length}）</h3>
          <button class="btn primary" onclick="window.__newTunnel()">+ 新增隧道</button>
        </div>
        ${renderTunnelTable(tunnels, false)}
      </div>
    `;
  }

  function tunnelModal(t) {
    const clients = state.clients;
    const type = t ? t.type : 'tcp';
    openModal(`
      <h3>${t ? '编辑隧道' : '新增隧道'}</h3>
      <div class="form-row"><label>名称</label><input id="f-tname" value="${esc(t ? t.name : '')}" placeholder="例如：家里的 Jellyfin" /></div>
      <div class="form-row">
        <label>类型（创建后不可修改）</label>
        <select id="f-type" ${t ? 'disabled' : ''}>
          <option value="tcp" ${type === 'tcp' ? 'selected' : ''}>TCP 端口映射</option>
          <option value="http" ${type === 'http' ? 'selected' : ''}>HTTP 域名映射</option>
        </select>
      </div>
      <div class="form-row">
        <label>所属客户端</label>
        <select id="f-client">
          ${clients
            .map((c) => `<option value="${c.id}" ${t && t.clientId === c.id ? 'selected' : ''}>${esc(c.name)} (${c.online ? '在线' : '离线'})</option>`)
            .join('')}
        </select>
      </div>
      <div class="form-grid">
        <div class="form-row"><label>本地地址</label><input id="f-laddr" value="${esc(t ? t.localAddr : '127.0.0.1')}" placeholder="127.0.0.1" /></div>
        <div class="form-row"><label>本地端口</label><input id="f-lport" type="number" value="${t ? t.localPort : 80}" /></div>
      </div>
      <div id="tcp-fields" class="form-row">
        <label>远程端口（留空自动分配 ${esc(state.overview ? `${state.overview.settings.tunnelPortStart}-${state.overview.settings.tunnelPortEnd}` : '')}）</label>
        <input id="f-rport" type="number" value="${t && t.remotePort ? t.remotePort : ''}" placeholder="自动分配" />
      </div>
      <div id="http-fields" class="form-row hidden">
        <label>域名（不含端口，如 app.example.com）</label>
        <input id="f-host" value="${esc(t && t.host ? t.host : '')}" placeholder="app.example.com" />
        <div class="muted" style="font-size:12px;margin-top:4px">将 ${esc(state.overview ? state.overview.settings.vhostPort : '')} 端口的该域名请求转发到本地服务</div>
      </div>
      <div class="modal-foot">
        <button class="btn" onclick="window.__closeModal()">取消</button>
        <button class="btn primary" id="save-tunnel">保存</button>
      </div>
    `);
    const toggleType = () => {
      const v = $('#f-type').value;
      $('#tcp-fields').classList.toggle('hidden', v !== 'tcp');
      $('#http-fields').classList.toggle('hidden', v !== 'http');
    };
    $('#f-type').onchange = toggleType;
    toggleType();
    $('#save-tunnel').onclick = async () => {
      const type = $('#f-type').value;
      const body = {
        name: $('#f-tname').value,
        clientId: $('#f-client').value,
        localAddr: $('#f-laddr').value,
        localPort: parseInt($('#f-lport').value, 10),
        remotePort: type === 'tcp' && $('#f-rport').value ? parseInt($('#f-rport').value, 10) : null,
        host: type === 'http' ? $('#f-host').value : null,
      };
      try {
        if (t) await api(`/api/tunnels/${t.id}`, 'PATCH', body);
        else await api('/api/tunnels', 'POST', body);
        toast(t ? '隧道已更新' : '隧道已创建');
        closeModal();
        await refreshAll();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  }

  window.__newTunnel = () => tunnelModal(null);
  window.__editTunnel = async (id) => {
    const tunnels = await loadTunnels();
    tunnelModal(tunnels.find((t) => t.id === id));
  };
  window.__toggleTunnel = async (id) => {
    const tunnels = await loadTunnels();
    const t = tunnels.find((x) => x.id === id);
    try {
      await api(`/api/tunnels/${id}`, 'PATCH', { enabled: !t.enabled });
      toast(t.enabled ? '隧道已停用' : '隧道已启用');
      await refreshAll();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  window.__delTunnel = (id) => {
    confirmAction('删除隧道', '确定删除该隧道？删除后端口映射立即失效。', async () => {
      try {
        await api(`/api/tunnels/${id}`, 'DELETE');
        toast('隧道已删除');
        await refreshAll();
      } catch (e) {
        toast(e.message, 'err');
      }
    });
  };

  /* ---------------- 日志 ---------------- */

  async function loadLogs() {
    state.logs = await api('/api/logs?limit=300');
  }

  function renderLogs() {
    const html = state.logs.length
      ? state.logs
          .map((l) => `<div class="log-line ${esc(l.level)}"><span class="time">${esc(l.time)}</span>[${esc(l.level)}] ${esc(l.msg)}</div>`)
          .join('')
      : '<div class="empty">暂无日志</div>';
    $('#content').innerHTML = `
      <div class="panel">
        <div class="panel-head">
          <h3>运行日志（最近 ${state.logs.length} 条）</h3>
          <button class="btn sm" onclick="window.__refreshLogs()">刷新</button>
        </div>
        <div class="log-box">${html}</div>
      </div>
    `;
  }

  window.__refreshLogs = async () => {
    try {
      await loadLogs();
      renderLogs();
    } catch (e) {
      toast(e.message, 'err');
    }
  };

  /* ---------------- 设置 ---------------- */

  async function renderSettings() {
    const s = await api('/api/settings');
    $('#content').innerHTML = `
      <div class="panel" style="max-width:640px">
        <div class="panel-head"><h3>面板账号</h3></div>
        <div style="padding:18px">
          <div class="form-row"><label>用户名</label><input id="s-user" value="${esc(s.panelUser)}" /></div>
          <div class="form-row"><label>当前密码</label><input id="s-curpass" type="password" placeholder="修改密码时填写" /></div>
          <div class="form-row"><label>新密码（至少 6 位，留空则不修改）</label><input id="s-newpass" type="password" placeholder="留空不修改" /></div>
        </div>
      </div>
      <div class="panel" style="max-width:640px">
        <div class="panel-head"><h3>端口设置（修改后需重启容器生效）</h3></div>
        <div style="padding:18px">
          <div class="form-grid">
            <div class="form-row"><label>面板端口</label><input id="s-panelport" type="number" value="${s.panelPort}" /></div>
            <div class="form-row"><label>agent 控制端口</label><input id="s-agentport" type="number" value="${s.agentPort}" /></div>
            <div class="form-row"><label>HTTP 域名端口</label><input id="s-vhostport" type="number" value="${s.vhostPort}" /></div>
            <div class="form-row"><label>TCP 自动分配起始端口</label><input id="s-pstart" type="number" value="${s.tunnelPortStart}" /></div>
            <div class="form-row"><label>TCP 自动分配结束端口</label><input id="s-pend" type="number" value="${s.tunnelPortEnd}" /></div>
          </div>
          <button class="btn primary" id="save-settings">保存设置</button>
        </div>
      </div>
    `;
    $('#save-settings').onclick = async () => {
      const body = {
        panelUser: $('#s-user').value,
        currentPassword: $('#s-curpass').value,
        newPassword: $('#s-newpass').value || null,
        panelPort: parseInt($('#s-panelport').value, 10),
        agentPort: parseInt($('#s-agentport').value, 10),
        vhostPort: parseInt($('#s-vhostport').value, 10),
        tunnelPortStart: parseInt($('#s-pstart').value, 10),
        tunnelPortEnd: parseInt($('#s-pend').value, 10),
      };
      try {
        await api('/api/settings', 'POST', body);
        toast('设置已保存（端口修改需重启容器生效）');
        await loadOverview();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  }

  /* ---------------- 事件流与刷新 ---------------- */

  let refreshTimer = null;
  async function refreshAll() {
    try {
      await loadOverview();
      renderView();
    } catch (e) {
      if (e.message !== '登录已过期') toast(e.message, 'err');
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshAll();
    }, 600);
  }

  async function startEvents() {
    if (!state.token) return;
    try {
      const res = await fetch('/api/events', { headers: { Authorization: `Bearer ${state.token}` } });
      if (!res.ok || !res.body) {
        setTimeout(startEvents, 3000);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const evt = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const m = /^data: (.+)$/m.exec(evt);
          if (m) {
            try {
              const d = JSON.parse(m[1]);
              if (d.type === 'change') scheduleRefresh();
            } catch {}
          }
        }
      }
    } catch {}
    setTimeout(startEvents, 3000);
  }

  /* ---------------- 入口 ---------------- */

  function enterApp() {
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    $('#user-chip').textContent = state.user;
    switchView('overview');
    loadOverview().catch((e) => toast(e.message, 'err'));
    startEvents();
  }

  function init() {
    window.__closeModal = closeModal;
    window.__go = switchView;

    $('#login-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await login($('#login-user').value.trim(), $('#login-pass').value);
      } catch (err) {
        toast(err.message, 'err');
      }
    };
    $('#logout-btn').onclick = logout;
    $$('.sidebar nav a').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      switchView(a.dataset.view);
    }));
    $('#modal-mask').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal();
    });

    if (state.token) {
      enterApp();
    } else {
      $('#login-view').classList.remove('hidden');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
