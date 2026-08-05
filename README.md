# 内网穿透面板（TunnelPanel）

一个轻量、零依赖的内网穿透管理面板，参照 [nps](https://github.com/ehang-io/nps) 和 [frp](https://github.com/fatedier/frp) 的用法设计：**服务端**运行在群晖或其他带 Docker 的机器上，提供 Web 管理面板与隧道网关；**agent** 运行在内网业务机（群晖、Windows、Linux、Docker 均可），连接服务端后自动接收隧道配置，无需在 agent 侧手写配置。

## 功能特性

- Web 管理面板：概览、客户端、隧道、日志、设置，全中文界面，实时状态推送
- TCP 端口映射：如 `0.0.0.0:21000 -> 内网机 127.0.0.1:8080`
- HTTP 域名映射：多个域名共享一个端口，按 `Host` 路由到不同内网服务
- 服务端集中管理：隧道配置只在面板上维护，agent 拿到 token 即用
- 自动分配远程端口（默认 20000-29999），也可手动指定
- 客户端 token 鉴权、在线状态、连接数实时统计、启停/禁用
- 数据持久化到 JSON 文件（原子写入），无需数据库
- **零 npm 依赖**：不需要 `npm install`，拷贝源码即可运行

## 架构

```
公网访问者 ──> 服务端(带 Docker 的机器/群晖)
                 ├─ 8080  Web 管理面板（HTTP API + 静态页面）
                 ├─ 9000  agent 控制连接（长连接，TCP）
                 ├─ 8090  HTTP 域名隧道（按 Host 路由）
                 └─ 20000-29999  TCP 隧道端口
                        │
                        │  单个长连接 + 多路复用（sid 区分）
                        ▼
                    内网 agent ──> 本地业务服务（127.0.0.1:8080 等）
```

agent 只需要能**主动访问**服务端的 9000 端口（常见的 NAT、防火墙都能放行出站连接），服务端再根据面板上的隧道配置把公网流量转发进这条连接。

## 快速开始（Docker Compose）

在目标机器上：

```bash
git clone <本项目> && cd 内网穿透
docker compose up -d --build
```

然后打开 `http://服务器IP:8080`，默认账号 `admin / admin123`（登录后请立即修改密码）。

### 直接拉取 Docker Hub 镜像（推荐）

镜像已发布到 Docker Hub（多架构：amd64 / arm64 / armv7），无需本地构建：

```bash
docker compose -f docker-compose.hub.yml up -d
```

或直接运行：

```bash
docker pull amw1933/tpanel:latest
docker run -d --name tpanel --restart unless-stopped --network host \
  -v $(pwd)/data:/app/data \
  -e PANEL_PORT=8080 -e AGENT_PORT=9000 -e VHOST_PORT=8090 \
  -e PANEL_USER=admin -e PANEL_PASSWORD=你的密码 \
  amw1933/tpanel:latest
```

> 使用 host 网络模式直接用宿主机端口。不要用 `-p 20000-29999:20000-29999` 大范围映射，Docker 为每个端口生成 iptables 规则会非常慢甚至卡死。

也可以直接用镜像构建：

```bash
docker build -t tpanel .
docker run -d --name tpanel --restart unless-stopped --network host \
  -v $(pwd)/data:/app/data \
  -e PANEL_PORT=8080 -e AGENT_PORT=9000 -e VHOST_PORT=8090 \
  -e PANEL_USER=admin -e PANEL_PASSWORD=你的密码 \
  tpanel
```

## 群晖（Synology）部署步骤

1. 打开**套件中心**，安装 **Container Manager**（DSM 7.2+）。
2. 将本项目拷贝到 NAS 上的共享文件夹（例如 `/volume1/docker/tpanel`）。
3. 打开 Container Manager → **项目** → **新增**：
   - 名称随意，路径选择上面的文件夹
   - 来源选“使用 docker-compose.yml”，Container Manager 会自动识别
   - 点击“构建并启动”
4. 在路由器/防火墙上放行端口：`8080`（面板）、`9000`（agent）、`8090`（HTTP 域名）、`20000-29999`（TCP 隧道，按需）。
5. 打开 `http://群晖IP:8080` 即可使用。

> 如果隧道端口范围较大不想全放开，可以把 `docker-compose.yml` 里的端口范围改小，例如只映射 `21000-21010`。

## 使用流程

### 1. 创建客户端

面板 → 客户端 → 新增客户端（例如“家里NAS”），创建后点击“复制 Token”。

### 2. 启动 agent

agent 只需要知道服务端地址和 token，隧道配置由服务端自动下发。

**Docker 方式（推荐 Linux）：**

```bash
docker run -d --name tpanel-agent --restart unless-stopped \
  --network host \
  -e AGENT_SERVER=服务端IP:9000 \
  -e AGENT_TOKEN=上一步复制的token \
  tpanel:latest node agent/index.js
```

> 使用 `--network host` 是为了让 agent 能直接访问宿主机和内网其他机器的服务。如果 agent 也运行在群晖上，可以直接复用本项目的镜像。

**Node 方式（任何装了 Node.js 的机器）：**

```bash
node agent/index.js --server 服务端IP:9000 --token 上一步复制的token
```

Windows 上可以在 `cmd` 里运行同样命令（先安装 Node.js LTS）。

### 3. 创建隧道

面板 → 隧道 → 新增隧道：

- **TCP 端口映射**：填写本地地址（agent 机器视角，如 `127.0.0.1` 或内网其他 IP）和本地端口；远程端口留空自动分配，也可手动指定。
- **HTTP 域名映射**：填写域名（如 `app.example.com`），把该域名解析到服务端 IP，`Host` 匹配后自动转发到指定本地服务。

创建后，隧道状态变为“运行中”；agent 在线时，访问 `http://服务端IP:远程端口` 即可访问内网服务。

## 本地开发 / 无 Docker 运行

```bash
# 启动服务端（零依赖，无需 npm install）
node server/index.js

# 另开终端，启动一个演示内网服务
node scripts/demo.js

# 再开终端，创建客户端拿 token 后启动 agent
node agent/index.js --server 127.0.0.1:9000 --token <token>

# 面板上创建 TCP 隧道指向 127.0.0.1:9100，然后浏览器访问
# http://127.0.0.1:<远程端口>
```

Windows 可以直接双击 `start.bat`（已处理中文编码）；Linux/macOS 可运行 `./start.sh`。停止服务端直接 Ctrl+C 即可。

完整功能自测（启动服务端/agent/演示服务，验证 TCP、HTTP 域名、重连、删除等场景）：

```bash
node scripts/e2e-test.js
```

## 配置项

### 服务端环境变量（仅首次启动生效）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PANEL_USER` | `admin` | 面板用户名 |
| `PANEL_PASSWORD` | `admin123` | 面板初始密码 |
| `PANEL_PORT` | `8080` | 面板端口 |
| `AGENT_PORT` | `9000` | agent 控制端口 |
| `VHOST_PORT` | `8090` | HTTP 域名隧道端口 |
| `TUNNEL_PORT_START` / `TUNNEL_PORT_END` | `20000` / `29999` | TCP 自动分配端口范围 |
| `DATA_DIR` | `./data` | 数据目录 |

端口也可以在面板“设置”里修改，修改后需要重启容器生效。

### agent 参数

| 参数 | 环境变量 | 说明 |
| --- | --- | --- |
| `--server` | `AGENT_SERVER` | 服务端地址，如 `1.2.3.4:9000` |
| `--token` | `AGENT_TOKEN` | 客户端 token（必填） |
| `--name` | `AGENT_NAME` | 显示名称（可选，默认用面板上的名称） |

## 安全建议

- 首次登录后立即修改默认密码
- agent 端口只对信任的 agent 放行；建议在服务端防火墙限制 9000 端口的来源
- 面板端口不要直接暴露到公网，可搭配反代 + HTTPS
- 重新生成 token 会使旧 token 立即失效
- 不要将 `data/panel.json`（含密码哈希与 token）提交到版本库

## 常见问题

- **隧道显示“等待客户端”**：agent 未连接，检查 agent 日志与 9000 端口连通性。
- **端口被占用**：创建时面板会提示；若端口被系统其他程序占用，改为手动指定端口或换一个。
- **HTTP 隧道 404**：确认域名已解析到服务端，且面板中填写的域名与访问时 `Host` 一致。
- **agent 无法连上**：确认服务端 9000 端口已放行；agent 只需出站连接，通常 NAT 环境没有问题。
- **修改端口后不生效**：端口改动需要 `docker compose restart` 或重启容器。

## 项目结构

```
├── server/           服务端：入口、HTTP API、隧道网关
├── agent/            客户端 agent（连接 + 本地转发）
├── lib/              共享代码：协议、会话、存储、工具
├── web/              管理面板前端（零依赖原生 JS）
├── scripts/demo.js   本地测试用的演示服务
├── Dockerfile
└── docker-compose.yml
```

## 协议简述

agent 与服务端之间是一条 TCP 长连接，使用长度前缀帧（4 字节长度 + 1 字节类型），数据帧内带 4 字节 stream id 实现多路复用。控制帧为 JSON，数据帧为二进制流，并实现了双向背压与心跳保活。详见 `lib/protocol.js`。

## 路线图（暂未实现）

- UDP 隧道
- 服务端与 agent 之间 TLS 加密（目前建议部署在可信内网或配合 VPN）
- 连接数/流量统计图表
- 多用户与权限
- 原生二进制打包（可用 `pkg`/`esbuild` 将 agent 打成单文件 exe）

## License

MIT
