/**
 * session-manager.js - PTY 会话管理器（增强版）
 * 支持模型选择、会话历史持久化、CLI 自动授权
 */

const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ANSI_ESCAPE_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const ASSISTANT_NOISE_LINE_PATTERNS = [
    /^\(?use node --trace-deprecation\b/i,
    /^\(node:\d+\)\s*\[dep[^\]]+\]\s*deprecationwarning\b/i,
    /^deprecationwarning\b/i
];

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
        // 用户历史缓存（减少反复同步读盘）
        this.historyCache = new Map();

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
        this.runtimeStateFile = path.join(this.historyDir, '.runtime-active.json');
        this._recoverRuntimeState();

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

    _historyFileForUser(username) {
        return path.join(this.historyDir, `${username}.json`);
    }

    _normalizeHistoryItem(item) {
        if (!item || !item.sessionId) return null;
        const mode = item.mode === 'terminal' ? 'terminal' : 'chat';
        const fallbackTitle = `${item.agentId || 'agent'} / ${item.modelId || 'default'}`;
        return {
            sessionId: item.sessionId,
            agentId: item.agentId || 'unknown',
            modelId: item.modelId || 'default',
            mode,
            createdAt: Number(item.createdAt || Date.now()),
            endedAt: item.endedAt ? Number(item.endedAt) : undefined,
            filesCount: Number(item.filesCount || 0),
            title: item.title || fallbackTitle,
            hasTranscript: mode !== 'terminal',
            endedReason: item.endedReason || undefined
        };
    }

    _compactHistory(items) {
        const dedup = new Map();
        for (const raw of Array.isArray(items) ? items : []) {
            const item = this._normalizeHistoryItem(raw);
            if (!item) continue;
            const prev = dedup.get(item.sessionId);
            if (!prev) {
                dedup.set(item.sessionId, item);
                continue;
            }
            dedup.set(item.sessionId, {
                ...prev,
                ...item,
                createdAt: Number(prev.createdAt || 0) || Number(item.createdAt || 0),
                endedAt: Number(item.endedAt || prev.endedAt || 0) || undefined
            });
        }
        const arr = Array.from(dedup.values());
        arr.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
        return arr.slice(-80);
    }

    _readHistoryForUser(username) {
        if (this.historyCache.has(username)) {
            return this.historyCache.get(username);
        }
        const historyFile = this._historyFileForUser(username);
        if (!fs.existsSync(historyFile)) {
            this.historyCache.set(username, []);
            return [];
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
            const compacted = this._compactHistory(parsed);
            this.historyCache.set(username, compacted);
            return compacted;
        } catch (e) {
            this.historyCache.set(username, []);
            return [];
        }
    }

    _writeHistoryForUser(username, history) {
        const compacted = this._compactHistory(history);
        this.historyCache.set(username, compacted);
        fs.writeFileSync(this._historyFileForUser(username), JSON.stringify(compacted, null, 2));
    }

    _markUserSessionEnded(username, sessionId, ts = Date.now()) {
        const list = this.userSessions.get(username);
        if (!Array.isArray(list)) return;
        const item = list.find(i => i.sessionId === sessionId);
        if (item) item.endedAt = ts;
    }

    _persistRuntimeState() {
        const active = Array.from(this.sessions.values()).map(session => ({
            sessionId: session.sessionId,
            username: session.username,
            agentId: session.agentId,
            modelId: session.modelId,
            mode: session.mode,
            createdAt: session.createdAt,
            lastActivityAt: session.lastActivityAt || session.createdAt,
            title: session.title,
            filesCount: session.files.length,
            hasTranscript: session.mode !== 'terminal'
        }));
        try {
            if (active.length === 0) {
                if (fs.existsSync(this.runtimeStateFile)) {
                    fs.unlinkSync(this.runtimeStateFile);
                }
                return;
            }
            fs.writeFileSync(this.runtimeStateFile, JSON.stringify({
                updatedAt: Date.now(),
                activeSessions: active
            }, null, 2));
        } catch (e) {
            // 忽略写入失败
        }
    }

    _recoverRuntimeState() {
        if (!fs.existsSync(this.runtimeStateFile)) return;
        try {
            const data = JSON.parse(fs.readFileSync(this.runtimeStateFile, 'utf-8'));
            const active = Array.isArray(data?.activeSessions) ? data.activeSessions : [];
            const now = Date.now();
            for (const item of active) {
                const normalized = this._normalizeHistoryItem({
                    ...item,
                    endedAt: now,
                    endedReason: 'server_restart'
                });
                if (!normalized || !item?.username) continue;
                const history = this._readHistoryForUser(item.username);
                const next = history.filter(h => h.sessionId !== normalized.sessionId);
                next.push(normalized);
                this._writeHistoryForUser(item.username, next);
            }
        } catch (e) {
            // 忽略损坏状态文件
        } finally {
            try {
                fs.unlinkSync(this.runtimeStateFile);
            } catch (e) {
                // 忽略
            }
        }
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
            terminalReplayBuffer: '',
            terminalInputLine: '',
            messages: [],
            lastAssistantIndex: -1,
            started: false,
            mode: mode === 'terminal' ? 'terminal' : 'chat',
            hasTranscript: mode !== 'terminal',
            title: `${agentId} / ${modelId || 'default'}`,
            _historySaved: false,
            _startCommandSent: false,
            _readyFallbackTimer: null,
            subscribers: new Set(),
            // 上传文件列表
            files: [],
            pendingInputs: [],
            userMessageCount: 0
        };

        // 监听 PTY 输出
        ptyProcess.onData((data) => {
            this._touchSession(session);
            if (!session.started && session._startCommandSent && this._isSessionReadySignal(data)) {
                this._markSessionReady(session, 'prompt_signal');
            }
            session.outputBuffer += data;
            // 限制缓冲区大小（保留最新 200KB）
            if (session.outputBuffer.length > 200000) {
                session.outputBuffer = session.outputBuffer.slice(-160000);
            }
            this._appendTerminalOutputReplay(session, data);
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
            if (session._readyFallbackTimer) {
                clearTimeout(session._readyFallbackTimer);
                session._readyFallbackTimer = null;
            }
            // 保存历史
            this._saveHistory(session);
            this.sessions.delete(sessionId);
            const list = this.activeSessions.get(username);
            if (list) {
                this.activeSessions.set(username, list.filter(id => id !== sessionId));
            }
            this._markUserSessionEnded(username, sessionId);
            this._persistRuntimeState();
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
        this._persistRuntimeState();

        // 延迟发送启动命令（等 shell 就绪）
        setTimeout(() => {
            if (!this.sessions.has(sessionId)) return;
            const cmd = this._buildStartCommand(agent, modelId);
            session._startCommandSent = true;
            ptyProcess.write(cmd + '\r');
            // 启动后优先通过输出特征判定 ready；超时兜底避免首条消息永远卡住。
            const readyFallbackMs = agentId === 'gemini' ? 8000 : 4500;
            session._readyFallbackTimer = setTimeout(() => {
                if (!this.sessions.has(sessionId)) return;
                this._markSessionReady(session, 'fallback_timeout');
            }, readyFallbackMs);
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

    _isSessionReadySignal(data) {
        const text = String(data || '').replace(ANSI_ESCAPE_RE, '').toLowerCase();
        if (!text.trim()) return false;
        // Codex CLI 就绪信号
        if (
            text.includes('? for shortcuts') ||
            text.includes('tab to queue message') ||
            text.includes('context left') ||
            text.includes('/model to change') ||
            text.includes('send a message') ||
            text.includes('输入消息')
        ) {
            return true;
        }
        // Gemini CLI 就绪信号
        if (
            text.includes('logged in with google') ||
            text.includes('◇ ready') ||
            /plan:\s*gemini/i.test(text) ||
            text.includes('gemini>') ||
            text.includes('model:')
        ) {
            return true;
        }
        return /(^|\n)\s*[›>]\s*$/.test(text);
    }

    _markSessionReady(session, reason = 'unknown') {
        if (!session || session.started) return;
        session.started = true;
        if (session._readyFallbackTimer) {
            clearTimeout(session._readyFallbackTimer);
            session._readyFallbackTimer = null;
        }
        console.log(`[会话管理] 会话 ${session.sessionId} 已 ready（${reason}）`);
        this._flushPendingInputs(session);
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
            this._persistRuntimeState();
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
        this._appendTerminalInputReplay(session, text);
        if (!session.started) {
            this._touchSession(session);
            session.pendingInputs.push(text);
            console.log(`[会话管理] 会话 ${sessionId} 尚未 ready，消息进入队列（长度=${session.pendingInputs.length}）`);
            if (session.pendingInputs.length > 200) {
                session.pendingInputs = session.pendingInputs.slice(-120);
            }
            return;
        }
        this._touchSession(session);
        session.pty.write(text);
    }

    /**
     * 发送 chat 模式的用户消息到终端
     * 对 Gemini CLI 采用逐字符模拟输入，避免一次性大段文本导致无响应
     * 对 Codex 等其他 agent 使用一次性写入
     */
    sendChatInput(sessionId, text) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error('会话不存在');
        }
        this._appendTerminalInputReplay(session, text + '\r');

        const fullText = text + '\r';

        if (!session.started) {
            this._touchSession(session);
            session.pendingInputs.push(fullText);
            console.log(`[会话管理] 会话 ${sessionId} 尚未 ready，chat 消息进入队列（长度=${session.pendingInputs.length}）`);
            if (session.pendingInputs.length > 200) {
                session.pendingInputs = session.pendingInputs.slice(-120);
            }
            return;
        }

        this._touchSession(session);

        // Gemini CLI 需要逐字符输入模拟键盘打字，否则可能不处理一次性粘贴的大段文本
        if (session.agentId === 'gemini') {
            this._simulateTyping(session, fullText);
        } else {
            session.pty.write(fullText);
        }
    }

    /**
     * 逐字符模拟输入（带小延迟），适用于 Gemini CLI 等对粘贴输入不友好的工具
     */
    _simulateTyping(session, text, charDelay = 5) {
        if (!session || !text) return;
        const chars = Array.from(text);
        let index = 0;

        const typeNext = () => {
            if (index >= chars.length || !this.sessions.has(session.sessionId)) return;

            // 每次写入一小段（最多 10 个字符一批），加速输入同时保持兼容
            const batchSize = Math.min(10, chars.length - index);
            const batch = chars.slice(index, index + batchSize).join('');
            session.pty.write(batch);
            index += batchSize;

            if (index < chars.length) {
                setTimeout(typeNext, charDelay);
            }
        };

        typeNext();
    }

    _flushPendingInputs(session) {
        if (!session || !Array.isArray(session.pendingInputs) || session.pendingInputs.length === 0) return;
        const queued = session.pendingInputs.splice(0, session.pendingInputs.length);
        console.log(`[会话管理] 会话 ${session.sessionId} 回放排队消息 ${queued.length} 条`);
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
        session.userMessageCount = Number(session.userMessageCount || 0) + 1;
        if (isFirstUserMsg) {
            const short = text.replace(/\s+/g, ' ').trim().slice(0, 40);
            session.title = `${short || '新会话'} · ${session.modelId}`;
        }
        session.lastAssistantIndex = -1;
        if (session.messages.length > 2000) {
            session.messages = session.messages.slice(-1500);
        }
        this._persistRuntimeState();
    }

    /**
     * 调整终端大小
     */
    resize(sessionId, cols, rows) {
        const session = this.sessions.get(sessionId);
        if (session) {
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
        const diskHistory = this._readHistoryForUser(username);
        const runtimeHistory = this.userSessions.get(username) || [];
        const merged = new Map();

        for (const raw of diskHistory) {
            const item = this._normalizeHistoryItem(raw);
            if (!item) continue;
            merged.set(item.sessionId, item);
        }
        for (const raw of runtimeHistory) {
            const item = this._normalizeHistoryItem(raw);
            if (!item) continue;
            const prev = merged.get(item.sessionId);
            merged.set(item.sessionId, { ...prev, ...item });
        }
        return Array.from(merged.values());
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
            this._persistRuntimeState();
        }

        const history = this._readHistoryForUser(username);
        const item = history.find(h => h.sessionId === sessionId);
        if (!item) return;
        item.title = title;
        this._writeHistoryForUser(username, history);
    }

    /**
     * 删除会话历史与内容
     */
    deleteSessionHistory(username, sessionId) {
        const history = this._readHistoryForUser(username);
        const next = history.filter(h => h.sessionId !== sessionId);
        this._writeHistoryForUser(username, next);
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
        const history = this._readHistoryForUser(session.username);
        const entry = this._normalizeHistoryItem({
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
        if (entry) {
            const idx = history.findIndex(h => h.sessionId === entry.sessionId);
            if (idx >= 0) {
                history[idx] = { ...history[idx], ...entry };
            } else {
                history.push(entry);
            }
        }
        this._writeHistoryForUser(session.username, history);

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

    /**
     * 销毁指定会话
     */
    destroySession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            if (session._readyFallbackTimer) {
                clearTimeout(session._readyFallbackTimer);
                session._readyFallbackTimer = null;
            }
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
            this._markUserSessionEnded(session.username, sessionId);
            this._persistRuntimeState();
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
        this._persistRuntimeState();
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
        if (!session || session.mode !== 'chat' || !chunk) return;
        if (!Number(session.userMessageCount || 0)) {
            const hasUserMessage = Array.isArray(session.messages) && session.messages.some(m => m?.role === 'user');
            if (!hasUserMessage) return;
            session.userMessageCount = 1;
        }
        const filteredChunk = this._filterAssistantNoiseChunk(chunk);
        if (!filteredChunk) return;
        this._touchSession(session);
        if (session.lastAssistantIndex < 0 || !session.messages[session.lastAssistantIndex] || session.messages[session.lastAssistantIndex].role !== 'assistant') {
            session.messages.push({
                role: 'assistant',
                content: filteredChunk,
                ts: Date.now()
            });
            session.lastAssistantIndex = session.messages.length - 1;
        } else {
            session.messages[session.lastAssistantIndex].content += filteredChunk;
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

    _filterAssistantNoiseChunk(chunk) {
        const raw = String(chunk || '');
        if (!raw) return '';
        const normalized = raw.replace(/\r/g, '\n');
        const kept = [];
        for (const line of normalized.split('\n')) {
            const plain = line.replace(ANSI_ESCAPE_RE, '').trim();
            if (!plain) {
                if (kept.length > 0 && kept[kept.length - 1] !== '') kept.push('');
                continue;
            }
            if (ASSISTANT_NOISE_LINE_PATTERNS.some(re => re.test(plain))) continue;
            kept.push(line);
        }
        const compacted = kept.join('\n').replace(/\n{3,}/g, '\n\n');
        return compacted.trim() ? compacted : '';
    }

    _appendTerminalOutputReplay(session, chunk) {
        if (!session || session.mode !== 'terminal' || !chunk) return;
        let text = String(chunk);
        text = text
            .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
            .replace(ANSI_ESCAPE_RE, '')
            .replace(/\r(?!\n)/g, '\n')
            .replace(/\u0008/g, '')
            .replace(/[^\x09\x0A\x20-\x7E\u00A0-\uFFFF]/g, '');
        if (!text) return;
        session.terminalReplayBuffer += text;
        if (session.terminalReplayBuffer.length > 600000) {
            session.terminalReplayBuffer = session.terminalReplayBuffer.slice(-400000);
        }
    }

    _appendTerminalInputReplay(session, chunk) {
        if (!session || session.mode !== 'terminal' || !chunk) return;
        const raw = String(chunk);
        if (/^(?:\x1b\[(?:\?|>)[0-9;]*c)+$/.test(raw)) return;
        if (/^(?:[0-9]+(?:;[0-9]+)*c)+$/.test(raw) && raw.length <= 48) return;
        for (const ch of raw) {
            if (ch === '\r' || ch === '\n') {
                if (session.terminalInputLine) {
                    session.terminalReplayBuffer += session.terminalInputLine + '\n';
                    session.terminalInputLine = '';
                } else {
                    session.terminalReplayBuffer += '\n';
                }
                continue;
            }
            if (ch === '\u0003') {
                session.terminalReplayBuffer += '^C\n';
                session.terminalInputLine = '';
                continue;
            }
            if (ch === '\u007f' || ch === '\u0008') {
                session.terminalInputLine = session.terminalInputLine.slice(0, -1);
                continue;
            }
            if (ch >= ' ' && ch !== '\u007f') {
                session.terminalInputLine += ch;
            }
        }
        if (session.terminalReplayBuffer.length > 600000) {
            session.terminalReplayBuffer = session.terminalReplayBuffer.slice(-400000);
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
