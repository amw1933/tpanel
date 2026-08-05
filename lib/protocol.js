'use strict';

// 穿透协议：长度前缀帧
// 帧 = [4字节BE总长度][1字节类型][负载]
// 类型定义见 T，DATA 负载为 [4字节 stream id][数据块]

const HEADER = 5;
const MAX_FRAME = 16 * 1024 * 1024; // 单帧上限 16MB

const T = {
  HELLO: 0x01, // agent -> server {token, name}
  HELLO_OK: 0x02, // server -> agent {id, name}
  ERROR: 0x03, // {code, msg}
  OPEN: 0x04, // server -> agent {sid, tunId, type, dst, host}
  OPEN_OK: 0x05, // agent -> server {sid}
  OPEN_ERR: 0x06, // agent -> server {sid, err}
  DATA: 0x07, // 双向，sid + 数据块
  CLOSE: 0x08, // 双向，sid
  PING: 0x09,
  PONG: 0x0a,
  SYNC: 0x0b, // server -> agent 隧道配置 {tunnels: [...]}
  STATE: 0x0c, // agent -> server 状态 {conns: {tunId: count}}
};

function encode(type, payload) {
  let body;
  if (payload == null) body = Buffer.alloc(0);
  else if (Buffer.isBuffer(payload)) body = payload;
  else if (typeof payload === 'string') body = Buffer.from(payload, 'utf8');
  else body = Buffer.from(JSON.stringify(payload), 'utf8');
  const buf = Buffer.alloc(HEADER + body.length);
  buf.writeUInt32BE(HEADER + body.length, 0);
  buf[4] = type;
  body.copy(buf, HEADER);
  return buf;
}

function encodeData(sid, chunk) {
  const buf = Buffer.allocUnsafe(HEADER + 4 + chunk.length);
  buf.writeUInt32BE(HEADER + 4 + chunk.length, 0);
  buf[4] = T.DATA;
  buf.writeUInt32BE(sid, 5);
  chunk.copy(buf, HEADER + 4);
  return buf;
}

function encodeClose(sid) {
  const buf = Buffer.allocUnsafe(HEADER + 4);
  buf.writeUInt32BE(HEADER + 4, 0);
  buf[4] = T.CLOSE;
  buf.writeUInt32BE(sid, 5);
  return buf;
}

class Decoder {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames = [];
    while (this.buf.length >= HEADER) {
      const len = this.buf.readUInt32BE(0);
      if (len < HEADER || len > MAX_FRAME) {
        const err = new Error(`非法帧长度: ${len}`);
        err.fatal = true;
        throw err;
      }
      if (this.buf.length < len) break;
      const type = this.buf[4];
      const body = this.buf.subarray(HEADER, len);
      frames.push({ type, body: Buffer.from(body) });
      this.buf = this.buf.subarray(len);
    }
    return frames;
  }
}

module.exports = { T, HEADER, MAX_FRAME, encode, encodeData, encodeClose, Decoder };
