'use strict';

const crypto = require('crypto');

function genId(len = 12) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

function genToken(len = 24) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), s, 32).toString('hex');
  return `${s}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes('$')) return false;
  const [s, h] = stored.split('$');
  const hash = crypto.scryptSync(String(password), s, 32).toString('hex');
  const a = Buffer.from(h, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function maskSecret(secret) {
  if (!secret) return secret;
  if (secret.length <= 8) return '****';
  return secret.slice(0, 4) + '****' + secret.slice(-4);
}

function now() {
  return new Date().toISOString();
}

function fmtTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function parseHostPort(str, def) {
  // 支持 "host:port"、"host"、"port"
  let s = String(str || '').trim();
  if (!s) return null;
  const m = s.match(/^\[?([^\]]+)\]?:(\d+)$/);
  if (m) return { host: m[1], port: parseInt(m[2], 10) };
  if (/^\d+$/.test(s)) return { host: '0.0.0.0', port: parseInt(s, 10) };
  if (def != null) return { host: s, port: def };
  return { host: s, port: 0 };
}

module.exports = { genId, genToken, hashPassword, verifyPassword, maskSecret, now, fmtTime, parseHostPort };
