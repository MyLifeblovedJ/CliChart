# CliChat - 项目交接文档（给 Codex）

## 你是什么角色

你是一个开发者，需要在这台 Ubuntu 服务器上继续开发和部署 CliChat 项目。这个项目已经在本地 Mac 上开发完成并通过了基础验证，现在需要你在服务器上完成部署和优化。

## 项目简介

CliChat 是一个纯 Web 应用，用于将服务器上的 **Codex CLI** 和 **Gemini CLI** 包装成浏览器可访问的聊天界面，支持多人通过浏览器使用。

**核心架构**：Node.js + Express + WebSocket + node-pty（伪终端）

```
浏览器 ←→ WebSocket ←→ Node.js 后端 ←→ PTY 伪终端 ←→ CLI 进程（codex / gemini）
```

## 项目目录结构

```
clichat/
├── server.js              # 主服务器：Express HTTP + WebSocket
├── config.json            # 配置文件：用户账号、Agent定义、模型列表
├── package.json           # 依赖
├── lib/
│   ├── auth.js            # Token 认证模块
│   ├── session-manager.js # PTY 会话管理器（含模型选择、CLI认证继承、历史持久化）
│   └── file-handler.js    # 文件上传处理（multer）
├── public/
│   ├── index.html         # 登录页
│   ├── chat.html          # 聊天主界面（xterm.js 终端 + 文件面板 + @ 引用）
│   ├── css/style.css      # 暗色主题样式
│   └── js/app.js          # 前端逻辑（WebSocket、终端、文件上传、@ 引用弹窗）
├── uploads/               # 用户上传的文件（按用户名分目录）
└── history/               # 会话历史记录（JSON）
```

## 已完成的功能

1. ✅ 用户登录/登出（Cookie + Token 认证）
2. ✅ Agent 选择（Codex CLI / Gemini CLI）
3. ✅ 模型选择（Gemini: 2.5-pro/2.5-flash/2.0-flash, Codex: o4-mini/o3/gpt-4.1）
4. ✅ xterm.js 终端（完整终端模拟，支持 ANSI 颜色、光标等）
5. ✅ 文件上传（HTTP multipart，存到服务器 uploads/ 目录）
6. ✅ 左侧文件树面板（显示已上传文件，点击 @ 按钮插入引用）
7. ✅ @ 引用弹窗（输入 @ 弹出文件列表，键盘导航 ↑↓Enter）
8. ✅ WebSocket 断线自动重连
9. ✅ CLI 自动授权（PTY 继承服务器已有的 gemini/codex 登录状态）
10. ✅ 会话历史持久化到 history/ 目录
11. ✅ 深色主题 UI，响应式布局

## 默认配置

- **默认端口**: 3000
- **默认用户**: admin / admin123, user1 / user123, user2 / user123
- **Agent启动命令**: `gemini` 和 `codex`（直接调用，不带路径）
- **模型选择**: 通过 CLI 参数传递，如 `gemini -m gemini-2.5-pro` 或 `codex --model o4-mini`

## 在服务器上需要完成的任务

### 任务 1：环境准备和部署

```bash
# 1. 确保 Node.js 已安装（需要 v18+）
node --version
# 如果没有：
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs

# 2. 进入项目目录，安装依赖
cd /path/to/clichat
npm install

# 3. 确认 codex 和 gemini 命令可用
which codex
which gemini

# 4. 测试启动
node server.js
# 应看到启动信息，访问 http://服务器IP:3000

# 5. 创建 systemd 服务（后台运行）
sudo tee /etc/systemd/system/clichat.service << 'EOF'
[Unit]
Description=CliChat Web Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/path/to/clichat
ExecStart=/usr/bin/node /path/to/clichat/server.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production
Environment=HOME=/root

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable clichat
sudo systemctl start clichat

# 6. 开放防火墙端口
sudo ufw allow 3000/tcp
```

> **重要**：systemd 中的 `/path/to/clichat` 替换为实际项目路径。

### 任务 2：修改 config.json

根据服务器实际情况修改 `config.json`：

1. **修改用户密码** — 默认密码仅用于测试，生产环境必须修改
2. **确认 Agent 命令** — 确保 `codex` 和 `gemini` 命令名正确且在 PATH 中
3. **调整模型列表** — 根据你实际可用的模型增删 `models` 数组
4. **端口** — 如需修改监听端口，改 `port` 字段

### 任务 3：验证核心功能

部署完成后，从外网浏览器访问 `http://服务器公网IP:3000`，验证：

1. 登录功能 — 用 admin/admin123 登录
2. 选择 Gemini CLI + 选择模型 → 启动 → 能看到终端输出
3. 在终端中输入问题 → AI 正常回复
4. 上传图片 → 文件出现在左侧文件树 → 在输入框用 @ 引用 → 发送给 AI
5. 停止 Agent → 重新选择 Codex CLI → 启动 → 测试同样功能
6. 用另一个浏览器/无痕窗口用 user1 登录 → 确认会话隔离

### 任务 4：可能需要修复的问题

1. **node-pty 编译问题** — node-pty 是原生模块，可能需要在服务器上重新编译：
   ```bash
   sudo apt install -y build-essential python3
   npm rebuild node-pty
   ```

2. **CLI 认证过期** — 如果 gemini 或 codex 的登录状态过期，需要手动重新登录：
   ```bash
   gemini   # 按提示完成 Google 账号登录
   codex    # 按提示完成 OpenAI 账号登录
   ```

3. **文件上传路径** — 确保 `uploads/` 目录有写入权限：
   ```bash
   chmod 755 uploads/
   ```

## 需要进一步优化的功能（可选）

如果你有时间，以下功能可以优化：

1. **HTTPS 支持** — 在 server.js 中添加 HTTPS 或前面挂 Nginx 反向代理
2. **用户注册** — 目前用户只能在 config.json 中手动添加
3. **图片预览** — 上传图片后在文件面板中显示缩略图
4. **会话保存/回放** — 将完整终端输出保存为文件，支持回看历史对话
5. **密码加密** — config.json 中的密码目前是明文，可改为 bcrypt 哈希

## 技术要点

- **为什么不用 Electron**：AionUi 是 Electron 应用，在 headless 服务器上依赖 D-Bus 和 xdg-open 等桌面 API，导致文件上传失败。CliChat 是纯 Node.js Web 应用，不依赖任何桌面环境。
- **CLI 自动授权原理**：session-manager.js 中的 `_getAuthEnvVars()` 方法确保 PTY 进程继承服务器的 HOME、XDG_CONFIG_HOME 等环境变量，CLI 工具通过这些路径找到已有的登录凭据。
- **文件引用方式**：用户上传文件后，文件存储到 `uploads/<username>/` 目录，文件的绝对路径通过 @ 引用传入终端输入，CLI 工具直接读取服务器磁盘上的文件。
