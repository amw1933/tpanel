@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 内网穿透面板正在启动... 浏览器打开 http://localhost:8080
node server/index.js
