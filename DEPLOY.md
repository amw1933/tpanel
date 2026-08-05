# SSH 部署手册（远程服务器 / 群晖）

完整步骤：登录服务器 → 装 Docker → 拉镜像启动 → 放行端口 → 初始化面板 → 部署 agent → 创建隧道。

## 1. 登录服务器

```bash
ssh root@你的服务器IP
```

## 2. 安装 Docker（如果还没有）

```bash
docker --version && docker compose version
```

如果提示找不到命令，用官方脚本一键安装（Ubuntu/Debian/CentOS 通用）：

```bash
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
docker compose version   # 确认 compose v2 可用
```

## 3. 部署面板（直接拉 Docker Hub 镜像）

```bash
mkdir -p /opt/tpanel && cd /opt/tpanel
```

创建 `docker-compose.hub.yml`（内容如下，直接复制）：

```yaml
services:
  panel:
    image: amw1933/tpanel:latest
    container_name: tpanel
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./data:/app/data
    environment:
      - PANEL_PORT=8080
      - AGENT_PORT=9000
      - VHOST_PORT=8090
      - PANEL_USER=admin
      - PANEL_PASSWORD=admin123   # 仅首次启动生效，登录后请在面板修改
```

> 使用 host 网络模式：容器直接用宿主机端口，**不要**用 `ports` 映射 `20000-29999:20000-29999` 这种写法，那会让 Docker 生成上万条 iptables 规则导致卡死。

**自定义端口**：如果默认端口（面板 8080 / agent 9000 / 域名 8090）和现有服务冲突，直接改下面的环境变量，例如：

```yaml
    environment:
      - PANEL_PORT=18080       # 管理面板
      - AGENT_PORT=19000       # agent 控制端口
      - VHOST_PORT=18090       # HTTP 域名隧道端口
      - TUNNEL_PORT_START=21000
      - TUNNEL_PORT_END=21999
```

> 注意：这些环境变量只在**首次启动**（data 目录为空）时生效。如果已经启动过一次，改端口请在面板“设置”里修改后重启容器；或删除 `/opt/tpanel/data` 重新初始化（会清空已有配置）。

启动：

```bash
docker compose -f docker-compose.hub.yml up -d
docker compose -f docker-compose.hub.yml ps
```

看到 `tpanel` 状态为 `Up` 即成功。日志：

```bash
docker logs -f tpanel
```

## 4. 放行端口

必须同时检查两处：

**云服务器安全组（阿里云/腾讯云等控制台）**：入方向放行 `8080`、`9000`、`8090`、`20000-29999`。

**服务器防火墙**：

```bash
# ufw（Debian/Ubuntu）
ufw allow 8080/tcp
ufw allow 9000/tcp
ufw allow 8090/tcp
ufw allow 20000:29999/tcp

# 或 firewalld（CentOS）
firewall-cmd --permanent --add-port=8080/tcp --add-port=9000/tcp --add-port=8090/tcp --add-port=20000-29999/tcp
firewall-cmd --reload
```

## 5. 初始化面板

浏览器打开 `http://你的服务器IP:8080`，默认账号 `admin / admin123`。

登录后立刻：**设置 → 修改用户名/密码**。

## 6. 在内网机器上部署 agent

先在面板 **客户端 → 新增客户端 → 复制 Token**，然后在有内网服务的机器上运行：

**方式一：Docker（推荐，Linux 内网机）**

```bash
docker run -d --name tpanel-agent --restart unless-stopped \
  --network host \
  -e AGENT_SERVER=你的服务器IP:9000 \
  -e AGENT_TOKEN=面板复制的token \
  amw1933/tpanel:latest node agent/index.js
```

**方式二：Node.js（任何装了 Node 的机器，含 Windows）**

```bash
node agent/index.js --server 你的服务器IP:9000 --token 面板复制的token
```

## 7. 创建隧道并验证

面板 → **隧道 → 新增隧道**：

- **TCP 端口映射**：本地地址填内网服务地址（如 `127.0.0.1`），本地端口填内网服务端口；远程端口留空自动分配（20000-29999）。
- **HTTP 域名映射**：填域名，把域名 A 记录解析到服务器 IP，访问时按 Host 自动转发。

创建后隧道状态变为“运行中”，浏览器访问 `http://你的服务器IP:自动分配的端口` 即可访问内网服务。

## 8. 常用运维

```bash
# 查看日志
docker logs -f tpanel

# 重启
docker compose -f /opt/tpanel/docker-compose.hub.yml restart

# 更新到最新镜像（GitHub 推送新代码后）
cd /opt/tpanel
docker compose -f docker-compose.hub.yml pull
docker compose -f docker-compose.hub.yml up -d

# 停止
docker compose -f docker-compose.hub.yml stop

# 删除容器（数据保留在 ./data）
docker compose -f docker-compose.hub.yml down
```

配置与日志保存在 `/opt/tpanel/data/`，备份整个目录即可。

## 9. 安全建议

- 修改默认密码后再对外开放面板
- 面板端口建议只对内网开放，或通过 Nginx/Caddy 反代加 HTTPS
- agent 控制端口 9000 只对信任的内网 agent 来源放行
- 定期备份 `/opt/tpanel/data/panel.json`
- 若隧道端口范围用不满，把 `20000-29999` 缩成实际用到的几个端口

## 常见问题

- **拉镜像很慢/失败**：国内网络问题，给 Docker 配置镜像加速器（在 `/etc/docker/daemon.json` 配置 `registry-mirrors`，使用你云厂商提供的加速地址），然后 `systemctl restart docker`。
- **面板打不开**：确认安全组和 ufw/firewalld 都放行了 8080。
- **agent 连不上**：确认服务器 9000 端口放行，且 agent 所在网络能出站。
- **HTTP 隧道 404**：域名解析到服务器 IP，且面板填的域名与访问时的 Host 一致。
- **修改端口不生效**：端口改动需要重启容器。
