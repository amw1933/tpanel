// 通用后台启动工具（本地测试用）
// 用法: node scripts/run-bg.js <输出日志文件> -- <命令> [参数...]
'use strict';

const fs = require('fs');
const { spawn } = require('child_process');

const dashIdx = process.argv.indexOf('--');
if (process.argv.length < 5 || dashIdx < 3) {
  console.error('用法: node scripts/run-bg.js <日志文件> -- <命令> [参数...]');
  process.exit(1);
}

const logFile = process.argv[2];
const cmd = process.argv[dashIdx + 1];
const args = process.argv.slice(dashIdx + 2);
const out = fs.openSync(logFile, 'a');
const child = spawn(cmd, args, { detached: true, stdio: ['ignore', out, out] });
child.unref();
console.log(child.pid);
