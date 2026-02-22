/**
 * server.js - CliChat 主服务器（增强版）
 * 支持模型选择、文件树管理、会话历史
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');

const Auth = require('./lib/auth');
const SessionManager = require('./lib/session-manager');
const FileHandler = require('./lib/file-handler');

// 加载配置
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const PORT = config.port || 3000;

// 初始化模块
const auth = new Auth(config);
const sessionManager = new SessionManager(config);
const fileHandler = new FileHandler(config);
const upload = fileHandler.getMiddleware();

// 创建 Express 应用
const app = express();
const server = http.createServer(app);

// 中间件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// 静态文件
app.use(express.static(path.join(__dirname, 'public')));

// ========== 认证 API ==========

// 已登录则直接跳转聊天页
app.get('/', (req, res, next) => {
    const token = req.cookies?.token;
    const username = auth.verify(token);
    if (username) {
        return res.redirect('/chat');
    }
    return next();
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: '请输入用户名和密码' });
    }
    const token = auth.login(username, password);
    if (!token) {
        return res.status(401).json({ error: '用户名或密码错误' });
    }
    res.cookie('token', token, {
        httpOnly: true,
        maxAge: config.sessionTimeout || 86400000
    });
    res.json({ success: true, username });
});

app.post('/api/logout', (req, res) => {
    const token = req.cookies?.token;
    if (token) {
        const username = auth.verify(token);
        if (username) {
            sessionManager.destroyUserSession(username);
        }
        auth.logout(token);
    }
    res.clearCookie('token');
    res.json({ success: true });
});

app.get('/api/auth/check', (req, res) => {
    const token = req.cookies?.token;
    const username = auth.verify(token);
    if (username) {
        res.json({ authenticated: true, username });
    } else {
        res.json({ authenticated: false });
    }
});

// ========== 需要认证的 API ==========

// 获取 Agent 列表（含模型信息）
app.get('/api/agents', auth.middleware(), (req, res) => {
    res.json(sessionManager.getAgents());
});

// 文件上传
app.post('/api/upload', auth.middleware(), upload.array('files', 10), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: '没有上传文件' });
    }
    const results = req.files.map(f => ({
        name: Buffer.from(f.originalname, 'latin1').toString('utf8'),
        path: f.path,
        size: f.size,
        type: getFileType(f.originalname)
    }));
    console.log(`[文件上传] 用户 ${req.username} 上传了 ${results.length} 个文件`);
    res.json({ success: true, files: results });
});

// 获取用户上传的文件列表
app.get('/api/files', auth.middleware(), (req, res) => {
    res.json(fileHandler.getUserFiles(req.username));
});

// 删除文件
app.delete('/api/files/:filename', auth.middleware(), (req, res) => {
    const success = fileHandler.deleteFile(req.username, req.params.filename);
    res.json({ success });
});

// 获取会话历史
app.get('/api/history', auth.middleware(), (req, res) => {
    res.json(sessionManager.getUserSessionHistory(req.username));
});

// 获取模型列表（优先从 CLI 列表获取，失败则回退到配置）
app.get('/api/models/:agentId', auth.middleware(), async (req, res) => {
    const agentId = req.params.agentId;
    const agent = config.agents.find(a => a.id === agentId);
    if (!agent) return res.status(404).json({ error: '未知的 Agent' });

    try {
        const models = await listModelsViaCli(agent);
        if (models.length > 0) {
            return res.json(models.map(id => ({
                id,
                name: id,
                flag: agent.id === 'codex' ? `--model ${id}` : `-m ${id}`
            })));
        }
    } catch (e) {
        // 忽略，回退到配置
    }

    res.json(agent.models || []);
});

// 获取活跃会话列表
app.get('/api/sessions/active', auth.middleware(), (req, res) => {
    const sessions = sessionManager.getUserActiveSessions(req.username).map(s => ({
        sessionId: s.sessionId,
        agentId: s.agentId,
        modelId: s.modelId,
        mode: s.mode || 'chat',
        hasTranscript: s.mode !== 'terminal',
        createdAt: s.createdAt,
        lastActivityAt: s.lastActivityAt || s.createdAt,
        title: s.title
    }));
    res.json(sessions);
});

// 获取会话历史内容
app.get('/api/history/:sessionId', auth.middleware(), (req, res) => {
    const sessionId = req.params.sessionId;
    const data = sessionManager.getSessionTranscript(req.username, sessionId);
    if (!data) {
        return res.status(404).json({ error: '历史记录不存在' });
    }
    res.json(data);
});

// 重命名会话
app.patch('/api/history/:sessionId', auth.middleware(), (req, res) => {
    const sessionId = req.params.sessionId;
    const title = (req.body?.title || '').toString().trim();
    if (!title) {
        return res.status(400).json({ error: '标题不能为空' });
    }
    sessionManager.setSessionTitle(req.username, sessionId, title);
    res.json({ success: true });
});

// 删除会话历史
app.delete('/api/history/:sessionId', auth.middleware(), (req, res) => {
    const sessionId = req.params.sessionId;
    sessionManager.deleteSessionHistory(req.username, sessionId);
    res.json({ success: true });
});

// 聊天页面
app.get('/chat', (req, res) => {
    const token = req.cookies?.token;
    const username = auth.verify(token);
    if (!username) {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});


// ========== WebSocket 服务 ==========

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const username = auth.verify(cookies.token);

    if (!username) {
        ws.send(JSON.stringify({ type: 'error', message: '未认证，请先登录' }));
        ws.close();
        return;
    }

    console.log(`[WebSocket] 用户 ${username} 已连接`);
    let currentSessionId = null;
    let currentSubscriber = null;

    const attachToSession = (sessionId) => {
        if (currentSessionId && currentSubscriber) {
            sessionManager.removeSubscriber(currentSessionId, currentSubscriber);
        }
        currentSessionId = sessionId;
        const boundSessionId = sessionId;
        currentSubscriber = (data) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'output', sessionId: boundSessionId, data }));
            }
        };
        sessionManager.addSubscriber(sessionId, currentSubscriber);
    };

    const sendActiveSessions = () => {
        const sessions = sessionManager.getUserActiveSessions(username).map(s => ({
            sessionId: s.sessionId,
            agentId: s.agentId,
            modelId: s.modelId,
            mode: s.mode || 'chat',
            hasTranscript: s.mode !== 'terminal',
            createdAt: s.createdAt,
            lastActivityAt: s.lastActivityAt || s.createdAt,
            title: s.title
        }));
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'sessions', sessions }));
        }
    };

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: '无效的消息格式' }));
            return;
        }

        switch (msg.type) {
            // 启动 Agent 会话（含模型选择）
            case 'start': {
                const { agentId, modelId } = msg;
                const mode = msg.mode === 'terminal' ? 'terminal' : 'chat';
                try {
                    const newSessionId = sessionManager.createSession(
                        username,
                        agentId,
                        modelId || 'default',
                        mode,
                        null,
                        (exitCode) => {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({
                                    type: 'exit',
                                    exitCode,
                                    message: `Agent 进程已退出 (code: ${exitCode})`
                                }));
                            }
                            if (currentSessionId === newSessionId) {
                                currentSessionId = null;
                            }
                            sendActiveSessions();
                        }
                    );

                    attachToSession(newSessionId);

                    ws.send(JSON.stringify({
                        type: 'started',
                        sessionId: newSessionId,
                        agentId,
                        modelId: modelId || 'default',
                        mode
                    }));
                    sendActiveSessions();
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'error', message: err.message }));
                }
                break;
            }

            // 发送输入到终端
            case 'input': {
                if (!currentSessionId) {
                    ws.send(JSON.stringify({ type: 'error', message: '请先启动一个 Agent' }));
                    return;
                }
                try {
                    sessionManager.sendInput(currentSessionId, msg.data);
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'error', message: err.message }));
                }
                break;
            }
            // 发送用户消息（用于历史记录）
            case 'user_message': {
                if (!currentSessionId) {
                    ws.send(JSON.stringify({ type: 'error', message: '请先启动一个 Agent' }));
                    return;
                }
                try {
                    const text = msg.text || '';
                    console.log(`[WebSocket] 用户 ${username} 发送 user_message 到会话 ${currentSessionId}（长度=${text.length}）`);
                    sessionManager.recordUserMessage(currentSessionId, text);
                    // 发送输入到终端（sendInput 内部会针对不同 Agent 做适配）
                    sessionManager.sendChatInput(currentSessionId, text);
                    sendActiveSessions();
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'error', message: err.message }));
                }
                break;
            }

            // 添加文件到会话
            case 'add_file': {
                if (currentSessionId) {
                    sessionManager.addFile(currentSessionId, msg.filePath, msg.fileName);
                    ws.send(JSON.stringify({
                        type: 'file_added',
                        files: sessionManager.getSessionFiles(currentSessionId)
                    }));
                }
                break;
            }

            // 获取会话文件列表
            case 'get_files': {
                if (currentSessionId) {
                    ws.send(JSON.stringify({
                        type: 'file_list',
                        files: sessionManager.getSessionFiles(currentSessionId)
                    }));
                }
                break;
            }

            // 调整终端大小
            case 'resize': {
                if (currentSessionId) {
                    sessionManager.resize(currentSessionId, msg.cols || 120, msg.rows || 40);
                }
                break;
            }

            // 停止当前会话
            case 'stop': {
                if (currentSessionId) {
                    if (currentSubscriber) {
                        sessionManager.removeSubscriber(currentSessionId, currentSubscriber);
                        currentSubscriber = null;
                    }
                    sessionManager.destroySession(currentSessionId);
                    currentSessionId = null;
                    ws.send(JSON.stringify({ type: 'stopped' }));
                    sendActiveSessions();
                }
                break;
            }

            // 恢复已有会话
            case 'resume': {
                const existingSessionId = sessionManager.getUserActiveSession(username);
                if (existingSessionId) {
                    const session = sessionManager.getSession(existingSessionId);
                    attachToSession(existingSessionId);
                    ws.send(JSON.stringify({
                        type: 'resumed',
                        sessionId: existingSessionId,
                        agentId: session.agentId,
                        modelId: session.modelId,
                        mode: session.mode || 'chat',
                        files: session.files
                    }));
                    const replay = session?.mode === 'terminal'
                        ? (session.terminalReplayBuffer || session.outputBuffer || '')
                        : '';
                    if (replay) {
                        ws.send(JSON.stringify({
                            type: 'output',
                            sessionId: existingSessionId,
                            data: replay
                        }));
                    }
                } else {
                    ws.send(JSON.stringify({ type: 'no_session' }));
                }
                sendActiveSessions();
                break;
            }

            // 切换会话
            case 'switch_session': {
                const { sessionId } = msg;
                const session = sessionManager.getSession(sessionId);
                if (!session || session.username !== username) {
                    ws.send(JSON.stringify({ type: 'error', message: '会话不存在或无权限' }));
                    break;
                }
                attachToSession(sessionId);
                ws.send(JSON.stringify({
                    type: 'session_switched',
                    sessionId,
                    agentId: session.agentId,
                    modelId: session.modelId,
                    mode: session.mode || 'chat',
                    files: session.files
                }));
                const replay = session.mode === 'terminal'
                    ? (session.terminalReplayBuffer || session.outputBuffer || '')
                    : '';
                if (replay) {
                    ws.send(JSON.stringify({ type: 'output', sessionId, data: replay }));
                }
                break;
            }

            // 解除当前会话绑定（不停止会话）
            case 'detach_session': {
                if (currentSessionId && currentSubscriber) {
                    sessionManager.removeSubscriber(currentSessionId, currentSubscriber);
                    currentSessionId = null;
                    currentSubscriber = null;
                    ws.send(JSON.stringify({ type: 'detached' }));
                }
                break;
            }

            // 停止指定会话
            case 'stop_session': {
                const { sessionId } = msg;
                const session = sessionManager.getSession(sessionId);
                if (session && session.username === username) {
                    if (currentSessionId === sessionId && currentSubscriber) {
                        sessionManager.removeSubscriber(currentSessionId, currentSubscriber);
                        currentSubscriber = null;
                    }
                    sessionManager.destroySession(sessionId);
                    if (currentSessionId === sessionId) {
                        currentSessionId = null;
                    }
                    ws.send(JSON.stringify({ type: 'session_stopped', sessionId }));
                    sendActiveSessions();
                }
                break;
            }

            default:
                ws.send(JSON.stringify({ type: 'error', message: `未知消息类型: ${msg.type}` }));
        }
    });

    ws.on('close', () => {
        console.log(`[WebSocket] 用户 ${username} 断开连接（会话保持运行）`);
        if (currentSessionId && currentSubscriber) {
            sessionManager.removeSubscriber(currentSessionId, currentSubscriber);
        }
    });

    ws.on('error', (err) => {
        console.error(`[WebSocket] 用户 ${username} 连接错误:`, err.message);
    });
});

// ========== 工具函数 ==========

function listModelsViaCli(agent) {
    return new Promise((resolve, reject) => {
        const shell = os.platform() === 'win32' ? 'cmd.exe' : 'bash';
        const homeDir = process.env.HOME || '/root';
        const authEnvVars = sessionManager.getAuthEnvVars();

        const ptyProcess = pty.spawn(shell, [], {
            name: 'xterm-256color',
            cols: 120,
            rows: 40,
            cwd: agent.workingDirectory || homeDir,
            env: {
                ...process.env,
                ...authEnvVars,
                TERM: 'xterm-256color',
                HOME: homeDir,
                NO_BROWSER: 'true',
                BROWSER: 'echo',
                GEMINI_CLI_NO_BROWSER: '1'
            }
        });

        let buffer = '';
        const killAndResolve = (models) => {
            try { ptyProcess.kill(); } catch { }
            resolve(models);
        };

        const timeout = setTimeout(() => {
            killAndResolve([]);
        }, 2500);

        ptyProcess.onData((data) => {
            buffer += data;
        });

        ptyProcess.onExit(() => {
            clearTimeout(timeout);
            const models = parseModelsFromOutput(buffer);
            resolve(models);
        });

        // 启动 CLI 并请求模型列表
        setTimeout(() => {
            ptyProcess.write(`${agent.command}\r`);
            setTimeout(() => {
                ptyProcess.write(`/model\r`);
                setTimeout(() => {
                    ptyProcess.write(`/exit\r`);
                }, 800);
            }, 800);
        }, 300);
    });
}

function parseModelsFromOutput(text) {
    if (!text) return [];
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const models = new Set();
    for (const line of lines) {
        const matches = line.match(/[a-z][a-z0-9._-]{2,}/gi);
        if (!matches) continue;
        for (const m of matches) {
            if (m.length < 4) continue;
            if (m.toLowerCase().includes('model')) continue;
            if (m.toLowerCase().includes('codex') || m.toLowerCase().includes('gpt') || m.toLowerCase().includes('gemini') || m.toLowerCase().includes('o3') || m.toLowerCase().includes('o4')) {
                models.add(m);
            }
        }
    }
    return Array.from(models);
}

function parseCookies(cookieStr) {
    const cookies = {};
    cookieStr.split(';').forEach(pair => {
        const [key, ...val] = pair.trim().split('=');
        if (key) cookies[key] = val.join('=');
    });
    return cookies;
}

function getFileType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];
    const codeExts = ['.js', '.ts', '.py', '.java', '.c', '.cpp', '.go', '.rs', '.rb', '.php', '.html', '.css', '.json', '.xml', '.yaml', '.yml', '.md', '.sh', '.sql'];
    const docExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv'];

    if (imageExts.includes(ext)) return 'image';
    if (codeExts.includes(ext)) return 'code';
    if (docExts.includes(ext)) return 'document';
    return 'other';
}

// ========== 优雅退出 ==========

process.on('SIGINT', () => {
    console.log('\n[服务器] 正在关闭...');
    sessionManager.destroyAll();
    server.close(() => {
        console.log('[服务器] 已关闭');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    sessionManager.destroyAll();
    server.close(() => process.exit(0));
});

// ========== 启动服务器 ==========

server.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════════╗
║            CliChat 服务已启动                ║
╠══════════════════════════════════════════════╣
║  地址: http://0.0.0.0:${String(PORT).padEnd(25)}║
║  用户: ${String(config.users.length + ' 个已配置').padEnd(37)}║
║  Agent: ${String(config.agents.map(a => a.name).join(', ')).padEnd(36)}║
║  默认账号: 请使用已配置账号                   ║
╚══════════════════════════════════════════════╝
  `);
});
