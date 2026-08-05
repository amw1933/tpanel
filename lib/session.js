'use strict';

// 对端连接会话：负责帧解码、流(stream)管理、数据转发与背压控制。
// 服务端与 agent 共用同一套逻辑，仅 onMessage/onClosed 由各自实现。

const { T, Decoder, encode, encodeData, encodeClose } = require('./protocol');

const MAX_PENDING = 4 * 1024 * 1024; // 单个方向最多缓存 4MB

class Session {
  constructor(socket) {
    this.socket = socket;
    this.decoder = new Decoder();
    this.streams = new Map(); // sid -> {sid, tunnel, socket, pendingHigh, waitingDrain, opened, timer}
    this.connsByTunnel = new Map(); // tunnelId -> 当前连接数
    this.closed = false;
    this.readingPaused = false;
    this.lastActive = Date.now();

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30 * 1000);
    socket.on('data', (chunk) => this.onChunk(chunk));
    socket.on('drain', () => this.onControlDrain());
    socket.on('close', () => this.close());
    socket.on('error', () => {});
  }

  onChunk(chunk) {
    if (this.closed) return;
    this.lastActive = Date.now();
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      this.close();
      return;
    }
    for (const f of frames) this.onFrame(f.type, f.body);
  }

  onFrame(type, body) {
    if (type === T.DATA) this.onDataFrame(body);
    else if (type === T.CLOSE) this.onCloseFrame(body);
    else this.onMessage(type, body);
  }

  onMessage() {
    throw new Error('not implemented');
  }

  onDataFrame(body) {
    if (body.length < 4) return;
    const sid = body.readUInt32BE(0);
    const chunk = body.subarray(4);
    const st = this.streams.get(sid);
    if (!st || !st.socket || st.socket.destroyed) return;
    const ok = st.socket.write(chunk);
    if (!ok) {
      st.pendingHigh = true;
      this.pauseReading();
    }
  }

  onCloseFrame(body) {
    if (body.length < 4) return;
    this.closeStream(body.readUInt32BE(0));
  }

  createStream(sid, tunnel) {
    const st = {
      sid,
      tunnel,
      socket: null,
      pendingSocket: null,
      buffered: null,
      pendingHigh: false,
      waitingDrain: false,
      opened: false,
      timer: null,
    };
    this.streams.set(sid, st);
    if (tunnel) {
      this.connsByTunnel.set(tunnel.id, (this.connsByTunnel.get(tunnel.id) || 0) + 1);
    }
    return st;
  }

  // 将目标 socket 挂到 sid 上开始双向转发
  attach(sid, socket) {
    const st = this.streams.get(sid);
    if (!st) {
      socket.destroy();
      return false;
    }
    st.socket = socket;
    st.pendingSocket = null;
    socket.on('data', (chunk) => {
      const ok = this.writeData(sid, chunk);
      if (!ok) {
        st.waitingDrain = true;
        socket.pause();
      }
    });
    socket.on('drain', () => {
      st.pendingHigh = false;
      this.resumeReadingIfOk();
    });
    socket.on('error', () => {});
    socket.on('close', () => this.closeStream(sid));
    return true;
  }

  writeData(sid, chunk) {
    if (this.closed) return false;
    return this.socket.write(encodeData(sid, chunk));
  }

  send(type, payload) {
    if (this.closed) return false;
    return this.socket.write(encode(type, payload));
  }

  sendClose(sid) {
    if (this.closed) return false;
    return this.socket.write(encodeClose(sid));
  }

  closeStream(sid) {
    const st = this.streams.get(sid);
    if (!st) return;
    this.streams.delete(sid);
    if (st.tunnel && this.connsByTunnel.has(st.tunnel.id)) {
      const n = this.connsByTunnel.get(st.tunnel.id) - 1;
      if (n <= 0) this.connsByTunnel.delete(st.tunnel.id);
      else this.connsByTunnel.set(st.tunnel.id, n);
    }
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
    if (st.socket && !st.socket.destroyed) st.socket.destroy();
    if (st.pendingSocket && !st.pendingSocket.destroyed) st.pendingSocket.destroy();
    st.socket = null;
    st.pendingSocket = null;
  }

  onControlDrain() {
    for (const st of this.streams.values()) {
      if (st.socket && st.waitingDrain && !st.socket.destroyed) {
        st.waitingDrain = false;
        st.socket.resume();
      }
    }
  }

  pauseReading() {
    if (!this.readingPaused) {
      this.readingPaused = true;
      this.socket.pause();
    }
  }

  resumeReadingIfOk() {
    if (!this.readingPaused) return;
    for (const st of this.streams.values()) {
      if (st.socket && st.pendingHigh) return;
    }
    this.readingPaused = false;
    this.socket.resume();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const sid of Array.from(this.streams.keys())) this.closeStream(sid);
    this.streams.clear();
    this.connsByTunnel.clear();
    try {
      this.socket.destroy();
    } catch {}
    this.onClosed();
  }

  onClosed() {}
}

module.exports = { Session };
