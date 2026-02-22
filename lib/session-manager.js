/**
 * session-manager.js - PTY 会话管理器（增强版）
 * 支持模型选择、会话历史持久化、CLI 自动授权
 */

const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');

class SessionManager {
    constructor(config) {
        // 可用的 Agent 配置
        this.agents = new Map();
        for (const agent of config.agents) {
            this.agents.set(agent.id, agent);
        }
        // 活跃会话: sessionId -> { pty, agentId, modelId, username, createdAt, outputBuffer }
        this.sessions = new Map();
        // 用户 -> 会话ID 列表的映射（一个用户可以有多个历史会话）
        this.userSessions = new Map();
        // 用户 -> 活跃会话ID 列表
        this.activeSessions = new Map();

        // 会话历史目录
        this.historyDir = path.resolve(config.historyDir || './history');
        if (!fs.existsSync(this.historyDir)) {
            fs.mkdirSync(this.historyDir, { recursive: true });
        }
        // 会话内容存储目录
        this.sessionsDir = path.join(this.historyDir, 'sessions');
        if (!fs.existsSync(this.sessionsDir)) {
            fs.mkdirSync(this.sessionsDir, { recursive: true });
        }

        this.inactiveSessionTimeout = Number(config.inactiveSessionTimeout || 30 * 60 * 1000);
        this._idleCheckTimer = setInterval(() => {
            this._cleanupInactiveSessions();
        }, 60 * 1000);
    }

    /**
     * 获取可用 Agent 列表（含模型信息）
     */
    getAgents() {
        return Array.from(this.agents.values()).map(a => ({
            id: a.id,
            name: a.name,
            description: a.description,
            models: a.models || [],
            fileRefPrefix: a.fileRefPrefix || '@'
        }));
    }

    /**
     * 为用户创建新的 CLI 会话
     * @param {string} username - 用户名
     * @param {string} agentId - Agent ID
     * @param {string} modelId - 模型 ID（可选）
     * @param {string} mode - 会话模式（chat/terminal）
     * @param {function} onData - 收到输出时的回调
     * @param {function} onExit - 进程退出时的回调
     * @returns {string} sessionId
     */
    createSession(username, agentId, modelId, mode, onData, onExit) {
        const agent = this.agents.get(agentId);
        if (!agent) {
            throw new Error(`未知的 Agent: ${agentId}`);
        }

        const sessionId = `${username}-${agentId}-${Date.now()}`;
        const shell = os.platform() === 'win32' ? 'cmd.exe' : 'bash';
        const homeDir = process.env.HOME || '/root';

        // 获取 CLI 认证相关的环境变量（继承服务器已有的认证状态）
        const authEnvVars = this._getAuthEnvVars();

        // 使用 node-pty 创建伪终端
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
                // 禁止 CLI 工具自动打开浏览器（headless 服务器用）
                NO_BROWSER: 'true',
                BROWSER: 'echo',
                // Gemini CLI 非交互式浏览器提示
                GEMINI_CLI_NO_BROWSER: '1'
            }
        });

        const session = {
            sessionId,
            pty: ptyProcess,
            agentId,
            modelId: modelId || 'default',
            username,
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
            outputBuffer: '',
            messages: [],
            lastAssistantIndex: -1,
            started: false,
            mode: mode === 'terminal' ? 'terminal' : 'chat',
            hasTranscript: mode !== 'terminal',
            title: `${agentId} / ${modelId || 'default'}`,
            _historySaved: false,
            subscribers: new Set(),
            // 上传文件列表
            files: [],
            pendingInputs: []
        };

        // 监听 PTY 输出
        ptyProcess.onData((data) => {
            this._touchSession(session);
            session.outputBuffer += data;
            // 限制缓冲区大小（保留最新 200KB）
            if (session.outputBuffer.length > 200000) {
                session.outputBuffer = session.outputBuffer.slice(-160000);
            }
            this._appendAssistantOutput(session, data);
            // 广播到订阅者
            for (const fn of session.subscribers) {
                try {
                    fn(data);
                } catch (e) {
                    // 忽略单个订阅者错误
                }
            }
            if (onData) onData(data);
        });

        // 监听进程退出
        ptyProcess.onExit(({ exitCode, signal }) => {
            console.log(`[会话管理] 会话 ${sessionId} 退出: code=${exitCode}, signal=${signal}`);
            // 保存历史
            this._saveHistory(session);
            this.sessions.delete(sessionId);
            const list = this.activeSessions.get(username);
            if (list) {
                this.activeSessions.set(username, list.filter(id => id !== sessionId));
            }
            if (onExit) onExit(exitCode, signal);
        });

        this.sessions.set(sessionId, session);
        if (!this.activeSessions.has(username)) {
            this.activeSessions.set(username, []);
        }
        this.activeSessions.get(username).push(sessionId);

        // 记录用户的会话列表
        if (!this.userSessions.has(username)) {
            this.userSessions.set(username, []);
        }
        this.userSessions.get(username).push({
            sessionId,
            agentId,
            modelId: modelId || 'default',
            mode: session.mode,
            createdAt: Date.now(),
            title: session.title,
            hasTranscript: session.hasTranscript
        });

        // 延迟发送启动命令（等 shell 就绪）
        setTimeout(() => {
            if (!this.sessions.has(sessionId)) return;
            const cmd = this._buildStartCommand(agent, modelId);
            ptyProcess.write(cmd + '\r');
            // 给 CLI 一点启动时间，再回放排队输入，避免首条消息被 shell 当命令执行。
            setTimeout(() => {
                if (!this.sessions.has(sessionId)) return;
                session.started = true;
                this._flushPendingInputs(session);
            }, 700);
        }, 500);

        console.log(`[会话管理] 创建会话 ${sessionId}: ${agent.command} (model: ${modelId || 'default'})`);
        return sessionId;
    }

    /**
     * 构建 CLI 启动命令（含模型选择参数）
     */
    _buildStartCommand(agent, modelId) {
        let cmd = agent.command;

        // 添加基础参数
        if (agent.args && agent.args.length > 0) {
            cmd += ' ' + agent.args.join(' ');
        }

        // 添加模型选择参数
        if (modelId && modelId !== 'default' && agent.models) {
            const model = agent.models.find(m => m.id === modelId);
            if (model && model.flag) {
                cmd += ' ' + model.flag;
            }
        }

        return cmd;
    }

    /**
     * 获取 CLI 认证相关的环境变量
     * Gemini CLI 和 Codex CLI 都依赖特定的环境变量和配置文件
     * 由于服务器上已经登录，PTY 进程会继承这些认证状态
     */
    _getAuthEnvVars() {
        const env = {};
        const homeDir = process.env.HOME || '/root';

        // Gemini CLI 认证：使用 ~/.config/gemini/ 下的凭据
        // Codex CLI 认证：使用 ~/.codex/ 或 ~/.config/openai/ 下的凭据
        // 这些凭据文件在 process.env 继承时自动可用

        // 确保 XDG 路径正确（某些 CLI 使用 XDG 标准）
        env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
        env.XDG_DATA_HOME = process.env.XDG_DATA_HOME || path.join(homeDir, '.local/share');
        env.XDG_CACHE_HOME = process.env.XDG_CACHE_HOME || path.join(homeDir, '.cache');
        env.XDG_STATE_HOME = process.env.XDG_STATE_HOME || path.join(homeDir, '.local/state');

        // 如果服务器上有 Google 认证 token
        if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
            env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        }

        // OpenAI API Key（如果有的话）
        if (process.env.OPENAI_API_KEY) {
            env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
        }

        return env;
    }

    getAuthEnvVars() {
        return this._getAuthEnvVars();
    }

    /**
     * 向会话添加文件引用
     */
    addFile(sessionId, filePath, fileName) {
        const session = this.sessions.get(sessionId);
        if (session) {
            this._touchSession(session);
            session.files.push({ path: filePath, name: fileName, addedAt: Date.now() });
        }
    }

    /**
     * 获取会话的文件列表
     */
    getSessionFiles(sessionId) {
        const session = this.sessions.get(sessionId);
        return session ? session.files : [];
    }

    /**
     * 向会话发送输入
     */
    sendInput(sessionId, text) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error('会话不存在');
        }
        if (!session.started) {
            this._touchSession(session);
            session.pendingInputs.push(text);
            if (session.pendingInputs.length > 200) {
                session.pendingInputs = session.pendingInputs.slice(-120);
            }
            return;
        }
        this._touchSession(session);
        session.pty.write(text);
    }

    _flushPendingInputs(session) {
        if (!session || !Array.isArray(session.pendingInputs) || session.pendingInputs.length === 0) return;
        const queued = session.pendingInputs.splice(0, session.pendingInputs.length);
        for (const chunk of queued) {
            this._touchSession(session);
            session.pty.write(chunk);
        }
    }

    /**
     * 订阅会话输出
     */
    addSubscriber(sessionId, fn) {
        const session = this.sessions.get(sessionId);
        if (session) {
            this._touchSession(session);
            session.subscribers.add(fn);
        }
    }

    /**
     * 取消订阅
     */
    removeSubscriber(sessionId, fn) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.subscribers.delete(fn);
        }
    }

    /**
     * 记录用户消息（用于历史）
     */
    recordUserMessage(sessionId, text) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error('会话不存在');
        }
        const isFirstUserMsg = !session.messages.some(m => m.role === 'user');
        this._touchSession(session);
        session.messages.push({
            role: 'user',
            content: text,
            ts: Date.now()
        });
        if (isFirstUserMsg) {
            const short = text.replace(/\s+/g, ' ').trim().slice(0, 40);
            session.title = `${short || '新会话'} · ${session.modelId}`;
        }
        session.lastAssistantIndex = -1;
        if (session.messages.length > 2000) {
            session.messages = session.messages.slice(-1500);
        }
    }

    /**
     * 调整终端大小
     */
    resize(sessionId, cols, rows) {
        const session = this.sessions.get(sessionId);
        if (session) {
            this._touchSession(session);
            session.pty.resize(cols, rows);
        }
    }

    /**
     * 获取用户当前活跃会话ID
     */
    getUserActiveSession(username) {
        const list = this.activeSessions.get(username) || [];
        return list.length > 0 ? list[list.length - 1] : null;
    }

    /**
     * 获取用户所有活跃会话
     */
    getUserActiveSessions(username) {
        const list = this.activeSessions.get(username) || [];
        return list.map(id => this.sessions.get(id)).filter(Boolean);
    }

    /**
     * 获取用户的会话历史列表
     */
    getUserSessionHistory(username) {
        // 先返回当前活跃的会话列表
        const history = this.userSessions.get(username) || [];

        // 再加载磁盘上的历史
        const historyFile = path.join(this.historyDir, `${username}.json`);
        if (fs.existsSync(historyFile)) {
            try {
                const savedHistory = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
                const enriched = savedHistory.map(h => {
                    if (typeof h.hasTranscript === 'undefined') {
                        h.hasTranscript = h.mode !== 'terminal';
                    }
                    if (!h.title) {
                        const title = this._getTitleFromTranscript(username, h.sessionId, h.modelId);
                        if (title) h.title = title;
                    }
                    return h;
                });
                return [...enriched, ...history];
            } catch (e) {
                // 忽略解析错误
            }
        }
        return history;
    }

    /**
     * 获取会话信息
     */
    getSession(sessionId) {
        return this.sessions.get(sessionId) || null;
    }

    /**
     * 设置会话标题
     */
    setSessionTitle(username, sessionId, title) {
        const session = this.sessions.get(sessionId);
        if (session && session.username === username) {
            session.title = title;
        }

        const historyFile = path.join(this.historyDir, `${username}.json`);
        if (!fs.existsSync(historyFile)) return;
        try {
            const history = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
            const item = history.find(h => h.sessionId === sessionId);
            if (item) {
                item.title = title;
                fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
            }
        } catch (e) {
            // 忽略
        }
    }

    /**
     * 删除会话历史与内容
     */
    deleteSessionHistory(username, sessionId) {
        const historyFile = path.join(this.historyDir, `${username}.json`);
        if (fs.existsSync(historyFile)) {
            try {
                const history = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
                const next = history.filter(h => h.sessionId !== sessionId);
                fs.writeFileSync(historyFile, JSON.stringify(next, null, 2));
            } catch (e) {
                // 忽略
            }
        }
        const transcriptFile = path.join(this.sessionsDir, username, `${sessionId}.json`);
        if (fs.existsSync(transcriptFile)) {
            try {
                fs.unlinkSync(transcriptFile);
            } catch (e) {
                // 忽略
            }
        }
    }

    /**
     * 保存会话历史到磁盘
     */
    _saveHistory(session) {
        if (!session || session._historySaved) return;
        session._historySaved = true;
        const historyFile = path.join(this.historyDir, `${session.username}.json`);
        let history = [];

        if (fs.existsSync(historyFile)) {
            try {
                history = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
            } catch (e) {
                history = [];
            }
        }

        history.push({
            sessionId: session.sessionId || `${session.username}-${session.agentId}-${session.createdAt}`,
            agentId: session.agentId,
            modelId: session.modelId,
            mode: session.mode,
            createdAt: session.createdAt,
            endedAt: Date.now(),
            filesCount: session.files.length,
            title: session.title,
            hasTranscript: session.mode !== 'terminal'
        });

        // 只保留最近 50 条
        if (history.length > 50) {
            history = history.slice(-50);
        }

        fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));

        // 终端模式不保存可回看消息正文，仅保留历史元信息
        if (session.mode === 'terminal') return;

        // 保存会话内容（按用户隔离）
        try {
            const userDir = path.join(this.sessionsDir, session.username);
            if (!fs.existsSync(userDir)) {
                fs.mkdirSync(userDir, { recursive: true });
            }
            const transcriptFile = path.join(userDir, `${session.sessionId}.json`);
            fs.writeFileSync(
                transcriptFile,
                JSON.stringify({
                    sessionId: session.sessionId,
                    agentId: session.agentId,
                    modelId: session.modelId,
                    mode: session.mode,
                    createdAt: session.createdAt,
                    endedAt: Date.now(),
                    messages: session.messages
                }, null, 2)
            );
        } catch (e) {
            // 忽略写入错误
        }
    }

    _getTitleFromTranscript(username, sessionId, modelId) {
        const data = this.getSessionTranscript(username, sessionId);
        if (!data || !Array.isArray(data.messages)) return null;
        const firstUser = data.messages.find(m => m.role === 'user' && m.content);
        if (!firstUser) return null;
        const short = firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 40);
        return `${short || '新会话'} · ${modelId || 'default'}`;
    }

    /**
     * 销毁指定会话
     */
    destroySession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            try {
                session.pty.kill();
            } catch (e) {
                // 进程可能已退出
            }
            this._saveHistory(session);
            this.sessions.delete(sessionId);
            const list = this.activeSessions.get(session.username);
            if (list) {
                this.activeSessions.set(session.username, list.filter(id => id !== sessionId));
            }
            console.log(`[会话管理] 已销毁会话 ${sessionId}`);
        }
    }

    /**
     * 销毁用户的当前会话
     */
    destroyUserSession(username) {
        const list = this.activeSessions.get(username) || [];
        for (const sessionId of list) {
            this.destroySession(sessionId);
        }
    }

    /**
     * 销毁所有会话
     */
    destroyAll() {
        if (this._idleCheckTimer) {
            clearInterval(this._idleCheckTimer);
            this._idleCheckTimer = null;
        }
        for (const [sessionId] of this.sessions) {
            this.destroySession(sessionId);
        }
    }

    /**
     * 读取指定会话的历史内容（按用户隔离）
     */
    getSessionTranscript(username, sessionId) {
        const active = this.sessions.get(sessionId);
        if (active && active.username === username) {
            if (active.mode === 'terminal') return null;
            return {
                sessionId: active.sessionId,
                agentId: active.agentId,
                modelId: active.modelId,
                mode: active.mode,
                createdAt: active.createdAt,
                endedAt: null,
                title: active.title,
                messages: active.messages
            };
        }
        const file = path.join(this.sessionsDir, username, `${sessionId}.json`);
        if (!fs.existsSync(file)) return null;
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            if (data?.mode === 'terminal') return null;
            return data;
        } catch (e) {
            return null;
        }
    }

    /**
     * 将 assistant 输出追加到消息中
     */
    _appendAssistantOutput(session, chunk) {
        if (!chunk) return;
        this._touchSession(session);
        if (session.lastAssistantIndex < 0 || !session.messages[session.lastAssistantIndex] || session.messages[session.lastAssistantIndex].role !== 'assistant') {
            session.messages.push({
                role: 'assistant',
                content: chunk,
                ts: Date.now()
            });
            session.lastAssistantIndex = session.messages.length - 1;
        } else {
            session.messages[session.lastAssistantIndex].content += chunk;
        }
        let total = 0;
        for (let i = session.messages.length - 1; i >= 0; i--) {
            total += session.messages[i].content.length;
            if (total > 2_000_000) {
                session.messages = session.messages.slice(i + 1);
                session.lastAssistantIndex = session.messages.length - 1;
                break;
            }
        }
    }

    _touchSession(session) {
        if (!session) return;
        session.lastActivityAt = Date.now();
    }

    _cleanupInactiveSessions() {
        if (!Number.isFinite(this.inactiveSessionTimeout) || this.inactiveSessionTimeout <= 0) return;
        const now = Date.now();
        const staleIds = [];
        for (const [sessionId, session] of this.sessions) {
            const last = session.lastActivityAt || session.createdAt || now;
            if (now - last > this.inactiveSessionTimeout) {
                staleIds.push(sessionId);
            }
        }
        for (const sessionId of staleIds) {
            const session = this.sessions.get(sessionId);
            console.log(`[会话管理] 会话 ${sessionId} 空闲超时，自动关闭（${Math.floor(this.inactiveSessionTimeout / 60000)} 分钟）`);
            this.destroySession(sessionId);
            if (session) {
                const list = this.userSessions.get(session.username);
                if (list) {
                    const item = list.find(i => i.sessionId === sessionId);
                    if (item) item.endedAt = Date.now();
                }
            }
        }
    }
}

module.exports = SessionManager;
