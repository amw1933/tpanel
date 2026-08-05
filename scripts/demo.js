// 本地测试用：启动一个简单的 HTTP 服务，模拟内网中的业务服务
// 用法：node scripts/demo.js [port]  （默认 9100）
'use strict';

const http = require('http');
const port = parseInt(process.argv[2] || '9100', 10);

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<h1>内网服务已连通</h1><p>你正在访问：${req.headers.host}${req.url}</p><p>时间：${new Date().toLocaleString()}</p>`);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`演示服务已启动: http://127.0.0.1:${port}`);
});
