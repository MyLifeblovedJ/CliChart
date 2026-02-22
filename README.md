# CliChat

把服务器上的 `codex` / `gemini` CLI 包装成一个可登录的 Web 聊天界面，支持会话历史、文件上传和终端模式。

## 功能

- 多用户登录（基于 `config.json`）
- Agent 切换（Codex / Gemini）
- 两种会话模式（聊天 UI / 原生终端）
- 会话历史保存与回看
- 终端模式会话只保留元信息，不保存可回看消息正文
- 文件上传与 `@文件路径` 引用
- 会话空闲 30 分钟自动关闭（可配置）

## 运行环境

- Node.js 18+
- 已安装并可直接执行的 CLI：
  - `codex`
  - `gemini`（可选，不用可从 `config.json` 删除）
- 对应 CLI 已在服务器上完成登录认证

## 快速开始

1. 安装依赖

```bash
npm install
```

2. 修改配置文件 `config.json`

3. 启动服务

```bash
npm start
```

4. 浏览器访问

```text
http://<服务器IP>:3000
```

## 配置说明（config.json）

当前版本默认使用 CLI 自身默认模型，不再在配置文件里维护模型列表。

最小 Agent 配置示例：

```json
{
  "id": "codex",
  "name": "Codex CLI",
  "command": "codex",
  "args": [],
  "description": "OpenAI Codex 编程助手",
  "fileRefPrefix": "@",
  "workingDirectory": null
}
```

主要字段：

- `port`: Web 服务端口
- `uploadDir`: 上传目录
- `maxFileSize`: 单文件大小限制（字节）
- `sessionTimeout`: 登录会话超时（毫秒）
- `historyDir`: 历史记录目录
- `inactiveSessionTimeout`: 空闲会话自动关闭时间（毫秒，默认 1800000）
- `users`: 用户名和密码列表
- `agents`: 可用 CLI Agent 列表

## 模型策略

- 前端不再提供模型下拉选择。
- 会话启动时不追加 `--model` / `-m` 参数。
- 实际模型由 CLI 默认配置决定。
- 如需临时切换，可在终端里使用 CLI 自带命令（例如 `/model`）。

## 常用目录

- `server.js`: 服务端入口（HTTP + WebSocket）
- `lib/session-manager.js`: PTY 会话管理与历史持久化
- `lib/file-handler.js`: 上传处理
- `public/`: 前端页面与脚本
- `history/`: 历史会话数据
- `uploads/`: 用户上传文件

## 安全注意

- `config.json` 中是明文账号密码，建议仅用于内网或开发环境。
- 生产环境建议接入真实身份认证，并使用 HTTPS。
- 请不要把敏感配置提交到公共仓库。
