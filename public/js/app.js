/**
 * app.js - CliChat 前端主逻辑（增强版）
 * 支持模型选择、文件树、@ 引用弹窗
 */

// ========== 全局状态 ==========
let ws = null;
let term = null;
let fitAddon = null;
let currentUsername = '';
let currentAgent = '';
let currentModel = '';
let currentSessionId = null;
let isConnected = false;
let sessionFiles = []; // 会话中已上传的文件
let agentsData = [];   // Agent 配置数据
let atPopupIndex = -1; // @ 弹窗选中索引
let chatMessages = [];
let lastAssistantEl = null;
let currentView = 'chat';
let historyModeSessionId = null;
let activeSessions = [];
let pendingUserMessage = null;
let selectedAgentId = '';
let lastUserMessageText = '';
let terminalRawBuffer = '';
let isStartingSession = false;
let pendingMode = 'chat';
let sessionMode = 'chat';
let pendingSwitchSessionId = null;
let focusedSessionId = null;
let agentSelectionConfirmed = false;
let modeSelectionConfirmed = false;
let bottomBarHideTimer = null;
let isAwaitingAssistant = false;
let assistantWaitStartedAt = 0;
let assistantWaitTimer = null;
const recentUserLinesBySession = new Map();
const transcriptCache = new Map();
const assistantStreamStateBySession = new Map();
const PRECHAT_TITLES = [
    '今天想要问点什么？',
    '你今日有什么安排吗？',
    '有什么我可以马上帮你推进的？',
    '今天先解决哪件关键的事？',
    '把你要做的事情交给我吧',
    '要不要先从最难的一个问题开始？',
    '你现在最想完成什么目标？',
    '今天我们一起把复杂问题拆简单',
    '先说你的需求，我来整理方案',
    '你要写代码、文档还是分析问题？',
    '准备好开始今天的高效会话了吗？',
    '告诉我你卡在哪里，我来接手',
    '想先做一个快速可用版本吗？',
    '今天想聊产品、技术还是流程？',
    '把任务发我，我们一步一步做完',
    '你负责目标，我负责落地细节',
    '现在就开始，先发第一条消息',
    '有新想法？我们可以马上验证',
    '你输入需求，我来给执行路径',
    '今天先把哪件事推进到可交付？'
];
const PRECHAT_INIT_GUARD_KEY = '__clichat_prechat_title_init_done__';
const pendingOutputWhileHydrating = new Map();
let hydratingTranscriptSessionId = null;

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', async () => {
    const auth = await checkAuth();
    if (!auth.authenticated) {
        window.location.href = '/';
        return;
    }
    setFilePanelCollapsed(true);
    setHistorySearchExpanded(false);
    currentUsername = auth.username;
    document.getElementById('usernameDisplay').textContent = `👤 ${currentUsername}`;
    document.getElementById('filePanel').style.display = 'flex';
    document.getElementById('historyPanel').style.display = 'flex';

    await loadAgents();
    await loadActiveSessions();
    await loadHistory();
    setupEventListeners();
    resetConversationEntryState(false);
    refreshPrechatTitle({ init: true });
    setConnectionStatus(isConnected);
    updateSessionStatus();
    updateSessionActionButtons();
});

// ========== 认证 ==========
async function checkAuth() {
    try {
        const res = await fetch('/api/auth/check');
        return await res.json();
    } catch {
        return { authenticated: false };
    }
}

// ========== Agent 管理 ==========
async function loadAgents() {
    try {
        const res = await fetch('/api/agents');
        agentsData = await res.json();
        // 默认选择 Codex，如不存在则选第一个
        const defaultAgent = agentsData.find(a => a.id === 'codex') || agentsData[0];
        if (defaultAgent) {
            setSelectedAgent(defaultAgent.id);
        }
    } catch {
        showToast('加载 Agent 列表失败', 'error');
    }
}

async function updateModelSelect() {
    // 模型交给 CLI 默认配置；用户可在终端 /model 切换
}

function setSelectedAgent(agentId, markConfirmed = false) {
    selectedAgentId = agentId;
    document.querySelectorAll('.agent-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.agent === agentId);
    });
    document.querySelectorAll('.agent-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.agent === agentId);
    });
    if (markConfirmed || !agentSelectionConfirmed) agentSelectionConfirmed = true;
    updateModelSelect();
    updatePrechatComposerState();
    updateSessionStatus();
}

function setPendingMode(mode, markConfirmed = false) {
    pendingMode = mode === 'terminal' ? 'terminal' : 'chat';
    document.querySelectorAll('.mode-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === pendingMode);
    });
    if (markConfirmed || !modeSelectionConfirmed) modeSelectionConfirmed = true;
    updatePrechatComposerState();
    updateSessionStatus();
}

function updatePrechatComposerState() {
    const prechatInput = document.getElementById('prechatInput');
    const prechatSendBtn = document.getElementById('prechatSendBtn');
    const ready = Boolean(selectedAgentId);
    const hasText = Boolean(prechatInput?.value.trim());
    if (prechatInput) {
        prechatInput.disabled = !ready || isStartingSession;
        prechatInput.placeholder = selectedAgentId === 'gemini'
            ? '给 Gemini 发送消息...'
            : '给 ChatGPT 发送消息...';
    }
    if (prechatSendBtn) prechatSendBtn.disabled = !ready || !hasText || isStartingSession;
}

function refreshPrechatTitle(options = {}) {
    const { init = false } = options;
    if (init) {
        if (window[PRECHAT_INIT_GUARD_KEY]) return;
        window[PRECHAT_INIT_GUARD_KEY] = true;
    }
    const titleEl = document.getElementById('prechatTitle');
    if (!titleEl) return;
    const idx = Math.floor(Math.random() * PRECHAT_TITLES.length);
    titleEl.textContent = PRECHAT_TITLES[idx];
}

function resetConversationEntryState(shouldRefreshTitle = true) {
    const fallbackAgent = agentsData.find(a => a.id === 'codex')?.id || agentsData[0]?.id || 'codex';
    const preferredAgent = selectedAgentId || currentAgent || fallbackAgent;
    currentAgent = '';
    currentModel = '';
    currentSessionId = null;
    activeSessionMeta = null;
    historyModeSessionId = null;
    isStartingSession = false;
    terminalRawBuffer = '';
    sessionMode = 'chat';
    currentView = 'chat';
    pendingMode = 'chat';
    agentSelectionConfirmed = true;
    modeSelectionConfirmed = true;
    focusedSessionId = null;
    pendingUserMessage = null;
    hydratingTranscriptSessionId = null;
    pendingOutputWhileHydrating.clear();
    clearAssistantStreamState();

    if (term) {
        term.dispose();
        term = null;
        fitAddon = null;
    }

    const prechatInput = document.getElementById('prechatInput');
    if (prechatInput) {
        prechatInput.value = '';
    }

    setSelectedAgent(preferredAgent, true);
    setPendingMode('chat', true);
    if (shouldRefreshTitle) refreshPrechatTitle();
    showAgentUI(false);
}

// ========== 视图切换 ==========
function setView(view) {
    currentView = view === 'terminal' ? 'terminal' : 'chat';
    document.body.classList.toggle('terminal-mode', currentView === 'terminal');
    showAgentUI(Boolean(currentSessionId));
}

function resetChatView() {
    chatMessages = [];
    lastAssistantEl = null;
    setAssistantPending(false);
    hydratingTranscriptSessionId = null;
    clearAssistantStreamState(currentSessionId);
    renderChatMessages(chatMessages);
}

function updateAssistantPendingText() {
    const textEl = document.getElementById('chatLoadingText');
    if (!textEl) return;
    const elapsedSec = Math.max(0, Math.floor((Date.now() - assistantWaitStartedAt) / 1000));
    textEl.textContent = `消息已发送，等待回复 ${elapsedSec}s`;
}

function setAssistantPending(pending) {
    const loadingEl = document.getElementById('chatLoading');
    if (!loadingEl) return;
    if (!pending) {
        isAwaitingAssistant = false;
        assistantWaitStartedAt = 0;
        if (assistantWaitTimer) {
            clearInterval(assistantWaitTimer);
            assistantWaitTimer = null;
        }
        loadingEl.style.display = 'none';
        return;
    }
    if (isAwaitingAssistant) return;
    isAwaitingAssistant = true;
    assistantWaitStartedAt = Date.now();
    loadingEl.style.display = 'inline-flex';
    updateAssistantPendingText();
    if (assistantWaitTimer) clearInterval(assistantWaitTimer);
    assistantWaitTimer = setInterval(updateAssistantPendingText, 1000);
}

function normalizeLineForEcho(text) {
    return String(text || '')
        .replace(ANSI_ESCAPE_RE, '')
        .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]/g, '')
        .replace(/^[>›➤•◦:：\-\s]+/, '')
        .replace(/[“”"'"`]+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[。！？.!?]+$/g, '')
        .toLowerCase();
}

function rememberUserLine(sessionId, text) {
    const sid = sessionId || currentSessionId;
    if (!sid) return;
    const normalized = normalizeLineForEcho(text);
    if (!normalized) return;
    const list = recentUserLinesBySession.get(sid) || [];
    list.push(normalized);
    if (list.length > 30) {
        list.splice(0, list.length - 30);
    }
    recentUserLinesBySession.set(sid, list);
}

function getRememberedUserLineSet(sessionId) {
    const sid = sessionId || currentSessionId;
    if (!sid) return new Set();
    return new Set(recentUserLinesBySession.get(sid) || []);
}

function stripEchoedUserLines(text, rememberedSet) {
    if (!text) return '';
    if (!rememberedSet || rememberedSet.size === 0) return text;
    const lines = text.split('\n');
    let start = 0;
    while (start < lines.length) {
        const normalized = normalizeLineForEcho(lines[start]);
        if (!normalized) {
            start += 1;
            continue;
        }
        if (!rememberedSet.has(normalized)) break;
        start += 1;
    }
    return lines.slice(start).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripEchoedUserLinesAnywhere(text, rememberedSet) {
    if (!text) return '';
    if (!rememberedSet || rememberedSet.size === 0) return text;
    const kept = text
        .split('\n')
        .filter(line => {
            const normalized = normalizeLineForEcho(line);
            return !normalized || !rememberedSet.has(normalized);
        });
    return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function trimSuspiciousAsciiTailAfterCjk(line) {
    const raw = String(line || '');
    const m = raw.match(/^(.*[\u4e00-\u9fff][^A-Za-z0-9]{0,4})([A-Za-z]{7,24})$/);
    if (!m) return raw;
    const tail = m[2];
    if (!/[A-Z]/.test(tail) || !/[a-z]/.test(tail)) return raw;
    return m[1].trimEnd();
}

function removeAssistantLinesSeenBefore(text, previousRaw) {
    if (!text) return '';
    if (!previousRaw) return text;
    const prevSet = new Set(
        String(previousRaw)
            .split('\n')
            .map(normalizeLineForEcho)
            .filter(Boolean)
    );
    if (prevSet.size === 0) return text;
    const kept = String(text)
        .split('\n')
        .filter(line => {
            const normalized = normalizeLineForEcho(line);
            return !normalized || !prevSet.has(normalized);
        });
    return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const ANSI_ESCAPE_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const NOISE_LINE_PATTERNS = [
    /^(r?oot)@[^#]+#\s*(codex|gemini)?\s*$/i,
    /^>_ openai codex/i,
    /^model:\s+/i,
    /^directory:\s+/i,
    /^tip:\s+/i,
    /^booting mcp server:/i,
    /^tab to queue message/i,
    /^\?\s*for shortcuts/i,
    /^\d+%\s*context left$/i,
    /^working\s*(\(|$)/i,
    /^preparing\s*(\(|$)/i,
    /^😼\s*已开启代理环境/i,
    /^↳\s+/,
    /alt\s*\+\s*[↑↓←→].*edit/i,
    /^\(?use node --trace-deprecation/i,
    /^to show where the warning was created\)?$/i,
    /^;?\s*◇\s*ready\b/i,
    /^logged in with google:/i,
    /^plan:\s*gemini/i,
    /^shift\+tab to accept edits/i,
    /^press ['"]?esc['"]?\s+for\s+normal\s+mode\.?/i,
    /^\[insert\]\s+/i,
    /^[a-z]\s*[•◦]$/i
];
const NOISE_SUBSTRINGS = [
    'openai codex',
    '/model to change',
    'directory: ~',
    'improve documentation in @filename',
    '? for shortcuts',
    'context left',
    'tab to queue message',
    'booting mcp server',
    'esc to interrupt',
    '已开启代理环境',
    'waiting for auth',
    'no sandbox (see /docs)',
    'trace-deprecation',
    'warning was created'
];

function stripAnsi(text) {
    return text.replace(ANSI_ESCAPE_RE, '');
}

function containsSubsequence(text, pattern) {
    if (!text || !pattern) return false;
    let i = 0;
    for (const ch of text) {
        if (ch === pattern[i]) i += 1;
        if (i >= pattern.length) return true;
    }
    return false;
}

function hasExcessiveRepeats(text) {
    let repeats = 0;
    let letters = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i].toLowerCase();
        if (/[a-z]/.test(ch)) {
            letters += 1;
            if (i > 0 && text[i - 1].toLowerCase() === ch) {
                repeats += 1;
            }
        }
    }
    return letters >= 12 && repeats >= Math.max(4, Math.floor(letters * 0.2));
}

function shouldDropChatLine(line) {
    const trimmed = line.trim();
    const lowered = trimmed.toLowerCase();
    const lettersOnly = lowered.replace(/[^a-z]/g, '');
    const compactLetters = lettersOnly.replace(/([a-z])\1+/g, '$1');
    const words = trimmed.split(/\s+/).filter(Boolean);
    const hasCjk = /[\u4e00-\u9fff]/.test(trimmed);
    if (!trimmed) return true;
    if (trimmed.length <= 1) return true;
    if (currentAgent === 'gemini' && /^chatgpt$/i.test(trimmed)) return true;
    if (lastUserMessageText && trimmed === lastUserMessageText.trim()) return true;
    if (NOISE_SUBSTRINGS.some(s => lowered.includes(s))) return true;
    if (
        ['booting', 'mcp', 'server', 'working', 'preparing', 'contextleft', 'shortcuts']
            .some(k => containsSubsequence(lettersOnly, k) || containsSubsequence(compactLetters, k))
    ) return true;
    if (NOISE_LINE_PATTERNS.some(re => re.test(trimmed))) return true;
    if (/^[╭╮╰╯│─]+$/.test(trimmed)) return true;
    if (/^[█░▀▄▌▐▖▗▘▙▛▜▟\s]{12,}$/.test(trimmed)) return true;
    if (/^[•◦]\s*(working|preparing|booting)\b/i.test(trimmed)) return true;
    if (!hasCjk && /^[a-z]\s*[•◦]$/i.test(trimmed)) return true;
    if (!hasCjk && /[•◦]/.test(trimmed) && lettersOnly.length >= 8) return true;
    if (/^›\s*/.test(trimmed)) return true;
    if (/^↳\s*/.test(trimmed)) return true;
    if (/alt\s*\+\s*[↑↓←→].*edit/i.test(trimmed)) return true;
    if (/^(r?oot)@[^#\n]+:?\s*(r?oot)?@?[^#\n]*#/.test(trimmed)) return true;
    if (/^(\d+%|\d+s)\b/.test(trimmed)) return true;
    if (!hasCjk && hasExcessiveRepeats(trimmed)) return true;
    if (!hasCjk && lettersOnly.length >= 28 && trimmed.split(/\s+/).length <= 3) return true;
    if (!hasCjk && /^[a-z]{2,4}$/.test(trimmed)) return true;
    if (!hasCjk && words.length >= 2 && words.length <= 4) {
        const shortWordCount = words.filter(w => w.length <= 2).length;
        const looksAscii = /^[a-z0-9: ._-]+$/i.test(trimmed);
        const mostlyConsonants = lettersOnly.length >= 4 && !/[aeiou]/.test(lettersOnly);
        if (looksAscii && shortWordCount >= words.length - 1 && (mostlyConsonants || /[A-Z]|:|\d|[•◦]/.test(trimmed))) {
            return true;
        }
    }
    if (/^[\[\]0-9;?=><\-+]*$/.test(trimmed)) return true;
    return false;
}

function sanitizeTerminalOutputForChat(text) {
    if (!text) return '';
    const withoutAnsi = stripAnsi(text)
        .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
        .replace(/\r/g, '\n')
        .replace(/\u0008/g, '')
        .replace(/[\u2500-\u257f]/g, '\n')
        .replace(/(?:^|\s)(r?oot)@[^#\n]*#\s*(codex|gemini)?/gi, '\n')
        .replace(/>_\s*openai codex[^\n]*/gi, '\n')
        .replace(/model:\s*[^\n]*\/model to change/gi, '\n')
        .replace(/directory:\s*~[^\n]*/gi, '\n')
        .replace(/improve documentation in @filename/gi, '\n')
        .replace(/\?\s*for shortcuts/gi, '\n')
        .replace(/\d+%\s*context left/gi, '\n')
        .replace(/tab to queue message/gi, '\n')
        .replace(/booting mcp server:[^\n]*/gi, '\n')
        .replace(/working\s*\([^\n]*\)/gi, '\n')
        .replace(/preparing[^\n]*\([^\n]*\)/gi, '\n')
        .replace(/😼\s*已开启代理环境/gi, '\n')
        .replace(/\(use node --trace-deprecation[^\n]*\)/gi, '\n')
        .replace(/to show where the warning was created\)?/gi, '\n')
        .replace(/;?\s*◇\s*ready[^\n]*/gi, '\n')
        .replace(/logged in with google:[^\n]*/gi, '\n')
        .replace(/plan:\s*gemini[^\n]*/gi, '\n')
        .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*waiting for auth[^\n]*/gi, '\n')
        .replace(/waiting for auth[^\n]*/gi, '\n')
        .replace(/shift\+tab to accept edits/gi, '\n')
        .replace(/press ['"]?esc['"]?\s+for\s+normal\s+mode\.?/gi, '\n')
        .replace(/\[insert\][^\n]*/gi, '\n')
        .replace(/[^\x09\x0A\x20-\x7E\u00A0-\uFFFF]/g, '');

    const lines = withoutAnsi
        .split('\n')
        .map(rawLine => {
            const hadPromptTail = /›\s*$/.test(rawLine);
            let line = rawLine
                .replace(/\u00a0/g, ' ')
                .replace(/\t/g, '    ')
                .replace(/\s+/g, ' ')
                .replace(/\s*›+\s*$/g, '')
                .replace(/^›+\s*/g, '')
                .trim();
            if (hadPromptTail) {
                line = line.replace(/^[•◦]\s+/, '');
            }
            return trimSuspiciousAsciiTailAfterCjk(line);
        })
        .filter(line => !/^[`~|\\/:;,.^_]+$/.test(line))
        .filter(line => !/^[a-z0-9;?=><\-\\\/]{2,}$/i.test(line))
        .filter(line => !shouldDropChatLine(line));

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function renderMarkdown(text) {
    if (typeof marked === 'undefined') return text;
    const html = marked.parse(text, { mangle: false, headerIds: false });
    if (typeof DOMPurify !== 'undefined') {
        return DOMPurify.sanitize(html);
    }
    return html;
}

function fallbackCopyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
        document.execCommand('copy');
    } catch {
        // 忽略
    }
    document.body.removeChild(ta);
}

function createCopyButton(codeText) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy-btn';
    btn.textContent = '复制';
    btn.addEventListener('click', async () => {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(codeText);
            } else {
                fallbackCopyText(codeText);
            }
            btn.textContent = '已复制';
            setTimeout(() => {
                btn.textContent = '复制';
            }, 1500);
        } catch {
            fallbackCopyText(codeText);
            btn.textContent = '已复制';
            setTimeout(() => {
                btn.textContent = '复制';
            }, 1500);
        }
    });
    return btn;
}

function enhanceMessageHtml(messageEl) {
    if (!messageEl) return;

    messageEl.querySelectorAll('a[href]').forEach(a => {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
    });

    messageEl.querySelectorAll('pre').forEach(pre => {
        if (pre.parentElement && pre.parentElement.classList.contains('code-block-wrapper')) return;
        const code = pre.querySelector('code');
        const codeText = code ? code.innerText : pre.innerText;
        const wrapper = document.createElement('div');
        wrapper.className = 'code-block-wrapper';

        const toolbar = document.createElement('div');
        toolbar.className = 'code-toolbar';

        const lang = document.createElement('span');
        lang.className = 'code-lang';
        const className = code?.className || '';
        const langMatch = className.match(/language-([a-z0-9_-]+)/i);
        lang.textContent = langMatch ? langMatch[1] : 'text';

        toolbar.appendChild(lang);
        toolbar.appendChild(createCopyButton(codeText));

        pre.parentNode.insertBefore(wrapper, pre);
        wrapper.appendChild(toolbar);
        wrapper.appendChild(pre);
    });

    messageEl.querySelectorAll('table').forEach(table => {
        if (table.parentElement && table.parentElement.classList.contains('table-wrapper')) return;
        const wrapper = document.createElement('div');
        wrapper.className = 'table-wrapper';
        table.parentNode.insertBefore(wrapper, table);
        wrapper.appendChild(table);
    });
}

function appendAssistantChunk(chunk, sessionId = currentSessionId) {
    const cleaned = sanitizeTerminalOutputForChat(chunk);
    if (!cleaned) return false;
    const rememberedSet = getRememberedUserLineSet(sessionId);
    let noEcho = stripEchoedUserLines(cleaned, rememberedSet);
    noEcho = stripEchoedUserLinesAnywhere(noEcho, rememberedSet);
    if (!noEcho) return false;
    setAssistantPending(false);
    const container = document.getElementById('chatMessages');
    if (!lastAssistantEl || lastAssistantEl.dataset.role !== 'assistant') {
        const divider = document.createElement('div');
        divider.className = 'assistant-divider';
        container.appendChild(divider);
        const el = document.createElement('div');
        el.className = 'chat-message assistant';
        el.dataset.role = 'assistant';
        el.dataset.raw = noEcho;
        el.innerHTML = renderMarkdown(noEcho);
        enhanceMessageHtml(el);
        container.appendChild(el);
        lastAssistantEl = el;
    } else {
        const previous = lastAssistantEl.dataset.raw || '';
        const deduped = removeAssistantLinesSeenBefore(noEcho, previous);
        if (!deduped) return false;
        if (previous.endsWith(deduped)) return true;
        const combined = previous ? `${previous}\n${deduped}` : deduped;
        lastAssistantEl.dataset.raw = combined;
        lastAssistantEl.innerHTML = renderMarkdown(combined);
        enhanceMessageHtml(lastAssistantEl);
    }
    container.scrollTop = container.scrollHeight;
    return true;
}

function getAssistantStreamState(sessionId) {
    const sid = sessionId || currentSessionId || '__global__';
    if (!assistantStreamStateBySession.has(sid)) {
        assistantStreamStateBySession.set(sid, { buffer: '', timer: null });
    }
    return { sid, state: assistantStreamStateBySession.get(sid) };
}

function clearAssistantStreamState(sessionId = null) {
    if (!sessionId) {
        assistantStreamStateBySession.forEach(({ timer }) => {
            if (timer) clearTimeout(timer);
        });
        assistantStreamStateBySession.clear();
        return;
    }
    const state = assistantStreamStateBySession.get(sessionId);
    if (state?.timer) clearTimeout(state.timer);
    assistantStreamStateBySession.delete(sessionId);
}

function queueOutputWhileHydrating(sessionId, chunk) {
    if (!sessionId || !chunk) return;
    const prev = pendingOutputWhileHydrating.get(sessionId) || '';
    const next = (prev + String(chunk));
    pendingOutputWhileHydrating.set(sessionId, next.length > 200000 ? next.slice(-160000) : next);
}

function flushQueuedOutputAfterHydrating(sessionId) {
    if (!sessionId) return;
    const queued = pendingOutputWhileHydrating.get(sessionId);
    pendingOutputWhileHydrating.delete(sessionId);
    if (!queued) return;
    appendAssistantChunkStream(queued, sessionId);
}

function shouldFlushPartialAssistantText(raw) {
    const plain = stripAnsi(String(raw || '')).replace(/\s+/g, ' ').trim();
    return plain.length > 0;
}

function flushAssistantStreamBuffer(sessionId) {
    const sid = sessionId || currentSessionId || '__global__';
    const current = assistantStreamStateBySession.get(sid);
    if (!current) return false;
    current.timer = null;
    const raw = current.buffer;
    current.buffer = '';
    if (!currentSessionId || sid !== currentSessionId) return false;
    if (!shouldFlushPartialAssistantText(raw)) return false;
    return appendAssistantChunk(raw, sid);
}

function appendAssistantChunkStream(chunk, sessionId = currentSessionId) {
    if (!chunk) return false;
    const { sid, state } = getAssistantStreamState(sessionId);
    state.buffer += String(chunk);
    if (state.buffer.length > 120000) {
        state.buffer = state.buffer.slice(-80000);
    }

    const normalized = state.buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const parts = normalized.split('\n');
    state.buffer = parts.pop() || '';

    let rendered = false;
    for (const part of parts) {
        rendered = appendAssistantChunk(part, sid) || rendered;
    }

    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
        flushAssistantStreamBuffer(sid);
    }, 220);

    return rendered;
}

function addUserMessage(text) {
    const container = document.getElementById('chatMessages');
    const el = document.createElement('div');
    el.className = 'chat-message user';
    el.dataset.role = 'user';
    el.textContent = text;
    container.appendChild(el);
    lastAssistantEl = null;
    rememberUserLine(currentSessionId, text);
    container.scrollTop = container.scrollHeight;
}

function renderChatMessages(messages) {
    const container = document.getElementById('chatMessages');
    container.innerHTML = '';
    lastAssistantEl = null;
    setAssistantPending(false);
    clearAssistantStreamState(currentSessionId);
    const seenUserLines = new Set();
    messages.forEach(m => {
        const el = document.createElement('div');
        el.className = `chat-message ${m.role}`;
        el.dataset.role = m.role;
        if (m.role === 'assistant') {
            const cleaned = sanitizeTerminalOutputForChat(m.content);
            if (!cleaned) return;
            const noEcho = stripEchoedUserLines(cleaned, seenUserLines);
            if (!noEcho) return;
            const divider = document.createElement('div');
            divider.className = 'assistant-divider';
            container.appendChild(divider);
            el.dataset.raw = noEcho;
            el.innerHTML = renderMarkdown(noEcho);
            enhanceMessageHtml(el);
        } else {
            el.textContent = m.content;
            seenUserLines.add(normalizeLineForEcho(m.content));
        }
        container.appendChild(el);
    });
    container.scrollTop = container.scrollHeight;
}

// ========== 事件绑定 ==========
function setupEventListeners() {
    const logoutBtn = document.getElementById('logoutBtn');
    const uploadButtons = Array.from(document.querySelectorAll('[data-upload-btn]'));
    const filePanelToggle = document.getElementById('filePanelToggle');
    const fileInput = document.getElementById('fileInput');
    const messageInput = document.getElementById('messageInput');
    const prechatInput = document.getElementById('prechatInput');
    const prechatSendBtn = document.getElementById('prechatSendBtn');
    const newChatBtn = document.getElementById('newChatBtn');
    const toggleHistorySearchBtn = document.getElementById('toggleHistorySearchBtn');
    const historySearchWrap = document.getElementById('historySearchWrap');
    const historySearch = document.getElementById('historySearch');
    document.querySelectorAll('.agent-option').forEach(btn => {
        btn.addEventListener('click', () => {
            setSelectedAgent(btn.dataset.agent, true);
        });
    });
    document.querySelectorAll('.mode-option').forEach(btn => {
        btn.addEventListener('click', () => {
            setPendingMode(btn.dataset.mode, true);
            if (
                btn.dataset.mode === 'terminal' &&
                !currentSessionId &&
                !historyModeSessionId &&
                !isStartingSession
            ) {
                sessionMode = 'terminal';
                startSelectedSession();
            }
        });
    });

    if (prechatSendBtn) prechatSendBtn.addEventListener('click', startPrechatConversation);
    if (prechatInput) {
        prechatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                startPrechatConversation();
            }
        });
        prechatInput.addEventListener('input', updatePrechatComposerState);
    }

    newChatBtn.addEventListener('click', () => {
        if (currentSessionId && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'detach_session' }));
        }
        isStartingSession = false;
        resetChatView();
        resetConversationEntryState();
        showToast('已创建新会话', 'info');
    });
    historySearch.addEventListener('input', renderHistoryList);
    if (toggleHistorySearchBtn && historySearchWrap) {
        toggleHistorySearchBtn.addEventListener('click', () => {
            const expanded = historySearchWrap.classList.contains('expanded');
            setHistorySearchExpanded(!expanded, true);
        });
    }
    document.addEventListener('click', (event) => {
        if (!event.target.closest('.history-item')) {
            closeHistoryMenus();
        }
    });

    logoutBtn.addEventListener('click', async () => {
        await fetch('/api/logout', { method: 'POST' });
        window.location.href = '/';
    });

    uploadButtons.forEach(btn => {
        btn.addEventListener('click', () => fileInput?.click());
    });
    fileInput?.addEventListener('change', handleFileUpload);
    if (filePanelToggle) {
        filePanelToggle.addEventListener('click', () => {
            const collapsed = document.body.classList.contains('right-panel-collapsed');
            setFilePanelCollapsed(!collapsed);
        });
    }

    messageInput.addEventListener('keydown', (e) => {
        // @ 弹窗中的键盘导航
        const popup = document.getElementById('atPopup');
        if (popup.style.display !== 'none') {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                navigateAtPopup(e.key === 'ArrowDown' ? 1 : -1);
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                selectAtPopupItem();
                return;
            }
            if (e.key === 'Escape') {
                hideAtPopup();
                return;
            }
        }

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // 粘贴上传（图片/文件）
    messageInput.addEventListener('paste', handlePasteUpload);
    if (prechatInput) {
        prechatInput.addEventListener('paste', handlePasteUpload);
    }

    // 监听 @ 输入
    messageInput.addEventListener('input', handleAtInput);

    // 自动调整输入框高度
    messageInput.addEventListener('input', () => {
        messageInput.style.height = 'auto';
        messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
    });

    setupDragDrop();

    window.addEventListener('resize', () => {
        if (fitAddon && term) {
            fitAddon.fit();
        }
    });
}

function setFilePanelCollapsed(collapsed) {
    document.body.classList.toggle('right-panel-collapsed', Boolean(collapsed));
    const toggle = document.getElementById('filePanelToggle');
    if (toggle) {
        toggle.textContent = collapsed ? '⟨' : '⟩';
        toggle.title = collapsed ? '展开文件栏' : '收起文件栏';
    }
}

function setHistorySearchExpanded(expanded, fromButton = false) {
    const wrap = document.getElementById('historySearchWrap');
    const input = document.getElementById('historySearch');
    const toggle = document.getElementById('toggleHistorySearchBtn');
    if (!wrap || !input) return;
    wrap.classList.toggle('expanded', Boolean(expanded));
    if (toggle) {
        toggle.innerHTML = expanded
            ? '<span class="action-icon">✕</span><span class="action-label">收起搜索</span>'
            : '<span class="action-icon">🔍</span><span class="action-label">搜索聊天</span>';
        toggle.title = expanded ? '收起搜索' : '搜索聊天';
    }
    if (expanded) {
        setTimeout(() => input.focus(), 60);
        return;
    }
    if (fromButton) {
        input.value = '';
        renderHistoryList();
    }
}

// ========== @ 引用系统 ==========
function handleAtInput() {
    const input = document.getElementById('messageInput');
    const value = input.value;
    const cursorPos = input.selectionStart;

    // 查找光标前最后一个 @ 符号
    const textBefore = value.substring(0, cursorPos);
    const atIndex = textBefore.lastIndexOf('@');

    if (atIndex >= 0 && (atIndex === 0 || textBefore[atIndex - 1] === ' ' || textBefore[atIndex - 1] === '\n')) {
        const query = textBefore.substring(atIndex + 1).toLowerCase();
        showAtPopup(query);
    } else {
        hideAtPopup();
    }
}

function showAtPopup(query) {
    const popup = document.getElementById('atPopup');
    const list = document.getElementById('atPopupList');

    if (sessionFiles.length === 0) {
        list.innerHTML = '<div class="at-popup-empty">暂无文件，请先上传</div>';
        popup.style.display = 'block';
        return;
    }

    const filtered = sessionFiles.filter(f =>
        f.name.toLowerCase().includes(query)
    );

    if (filtered.length === 0) {
        list.innerHTML = '<div class="at-popup-empty">无匹配文件</div>';
    } else {
        list.innerHTML = filtered.map((f, i) => `
      <div class="at-popup-item ${i === 0 ? 'selected' : ''}" data-index="${i}" data-path="${f.path}" data-name="${f.name}">
        <span class="at-icon">${getFileIcon(f.name)}</span>
        <span class="at-name">${f.name}</span>
        <span class="at-path">${f.path}</span>
      </div>
    `).join('');

        // 点击选择
        list.querySelectorAll('.at-popup-item').forEach(item => {
            item.addEventListener('click', () => {
                insertAtReference(item.dataset.path, item.dataset.name);
            });
        });
    }

    atPopupIndex = 0;
    popup.style.display = 'block';
}

function hideAtPopup() {
    document.getElementById('atPopup').style.display = 'none';
    atPopupIndex = -1;
}

function navigateAtPopup(direction) {
    const items = document.querySelectorAll('.at-popup-item');
    if (items.length === 0) return;

    items[atPopupIndex]?.classList.remove('selected');
    atPopupIndex = (atPopupIndex + direction + items.length) % items.length;
    items[atPopupIndex]?.classList.add('selected');
    items[atPopupIndex]?.scrollIntoView({ block: 'nearest' });
}

function selectAtPopupItem() {
    const items = document.querySelectorAll('.at-popup-item');
    if (items.length > 0 && atPopupIndex >= 0) {
        const item = items[atPopupIndex];
        insertAtReference(item.dataset.path, item.dataset.name);
    }
}

function insertAtReference(filePath, fileName) {
    const input = document.getElementById('messageInput');
    const value = input.value;
    const cursorPos = input.selectionStart;
    const textBefore = value.substring(0, cursorPos);
    const atIndex = textBefore.lastIndexOf('@');

    if (atIndex >= 0) {
        const before = value.substring(0, atIndex);
        const after = value.substring(cursorPos);
        input.value = `${before}@${filePath} ${after}`;
        const newPos = atIndex + filePath.length + 2;
        input.setSelectionRange(newPos, newPos);
    }

    hideAtPopup();
    input.focus();
}

// ========== 历史会话 ==========
let historyData = [];
let activeSessionMeta = null;

async function loadActiveSessions() {
    try {
        const res = await fetch('/api/sessions/active');
        activeSessions = await res.json();
    } catch {
        activeSessions = [];
    }
}

async function loadHistory() {
    try {
        const res = await fetch('/api/history');
        historyData = await res.json();
        renderHistoryList();
    } catch {
        historyData = [];
    }
}

function getHistorySortTime(item) {
    const ts = Number(item?.lastActivityAt || item?.endedAt || item?.createdAt || 0);
    return Number.isFinite(ts) ? ts : 0;
}

function renderHistoryList() {
    const list = document.getElementById('historyList');
    const highlightedSessionId = getHighlightedSessionId();
    const map = new Map();
    activeSessions.forEach(s => {
        map.set(s.sessionId, { ...s, active: true });
    });
    historyData.forEach(item => {
        if (!map.has(item.sessionId)) {
            map.set(item.sessionId, { ...item, active: false });
        }
    });

    const query = (document.getElementById('historySearch').value || '').toLowerCase();
    const items = Array.from(map.values())
        .filter(item => {
            const title = `${item.title || ''} ${item.agentId || ''} ${getModelDisplayName(item.agentId, item.modelId)}`.toLowerCase();
            return !query || title.includes(query);
        })
        .sort((a, b) => {
            const ta = getHistorySortTime(a);
            const tb = getHistorySortTime(b);
            if (tb !== ta) return tb - ta;
            return Number(b.createdAt || 0) - Number(a.createdAt || 0);
        });

    if (items.length === 0) {
        list.innerHTML = '<div class="file-tree-empty">暂无历史</div>';
        return;
    }

    const groups = {
        today: [],
        yesterday: [],
        earlier: []
    };
    items.forEach(item => groups[getHistoryGroup(getHistorySortTime(item))].push(item));

    const groupOrder = [
        { key: 'today', label: '今天' },
        { key: 'yesterday', label: '昨天' },
        { key: 'earlier', label: '更早' }
    ];

    list.innerHTML = groupOrder
        .filter(group => groups[group.key].length > 0)
        .map(group => {
            const rows = groups[group.key].map(item => renderHistoryItem(item, highlightedSessionId)).join('');
            return `
        <div class="history-group">
          <div class="history-group-title">${group.label}</div>
          ${rows}
        </div>
      `;
        })
        .join('');

    list.querySelectorAll('.history-item-main').forEach(el => {
        el.addEventListener('click', () => {
            const sessionId = el.dataset.session;
            const active = el.dataset.active === '1';
            const viewable = el.dataset.viewable !== '0';
            closeHistoryMenus();
            if (active) switchSession(sessionId);
            else if (viewable) openHistory(sessionId);
            else showToast('终端模式不保存可回看的消息历史', 'info');
        });
    });

    list.querySelectorAll('.history-more-btn').forEach(btn => {
        btn.addEventListener('click', (event) => {
            event.stopPropagation();
            const item = btn.closest('.history-item');
            const opened = item.classList.contains('menu-open');
            closeHistoryMenus();
            if (!opened) item.classList.add('menu-open');
        });
    });

    list.querySelectorAll('.history-menu button').forEach(btn => {
        btn.addEventListener('click', (event) => {
            event.stopPropagation();
            const sessionId = btn.dataset.session;
            const action = btn.dataset.action;
            closeHistoryMenus();
            if (action === 'switch') switchSession(sessionId);
            if (action === 'view') openHistory(sessionId);
            if (action === 'rename') renameSession(sessionId);
            if (action === 'delete') deleteSession(sessionId);
            if (action === 'stop') stopSpecificSession(sessionId);
        });
    });
}

function getHighlightedSessionId() {
    return pendingSwitchSessionId || historyModeSessionId || currentSessionId || focusedSessionId || null;
}

function closeHistoryMenus() {
    document.querySelectorAll('.history-item.menu-open').forEach(el => el.classList.remove('menu-open'));
}

function getModelDisplayName(agentId, modelId) {
    if (!modelId || modelId === 'default') {
        if (agentId === 'gemini') return 'Gemini';
        if (agentId === 'codex') return 'ChatGPT';
        return '模型';
    }
    return modelId;
}

function getSessionDisplayName(agentId, modelId) {
    const agentName = getAgentDisplayName(agentId);
    if (!modelId || modelId === 'default') return agentName;
    return `${agentName} · ${modelId}`;
}

function getSessionMetaById(sessionId) {
    if (!sessionId) return null;
    const active = activeSessions.find(item => item?.sessionId === sessionId);
    if (active) return active;
    const history = historyData.find(item => item?.sessionId === sessionId);
    if (history) return history;
    const cached = transcriptCache.get(sessionId);
    if (cached) return cached;
    return null;
}

function getCenterBadgeMeta() {
    if (historyModeSessionId) {
        const historyMeta = getSessionMetaById(historyModeSessionId);
        const agentId = historyMeta?.agentId || currentAgent || selectedAgentId || 'codex';
        const modelId = historyMeta?.modelId || currentModel || 'default';
        const cleanTitle = historyMeta ? getHistoryTitle(historyMeta) : '';
        const title = cleanTitle && cleanTitle !== '新会话' ? cleanTitle : '';
        return { agentId, modelId, title };
    }

    if (currentSessionId) {
        const activeMeta = getSessionMetaById(currentSessionId);
        const agentId = currentAgent || activeMeta?.agentId || selectedAgentId || 'codex';
        const modelId = currentModel || activeMeta?.modelId || 'default';
        const cleanTitle = activeMeta ? getHistoryTitle(activeMeta) : '';
        const title = cleanTitle && cleanTitle !== '新会话' ? cleanTitle : '';
        return { agentId, modelId, title };
    }

    return {
        agentId: selectedAgentId || 'codex',
        modelId: getSelectedModelId(),
        title: ''
    };
}

function getAgentDisplayName(agentId) {
    if (agentId === 'gemini') return 'Gemini';
    if (agentId === 'codex') return 'ChatGPT';
    return agentId || 'Agent';
}

function getHistoryTitle(item) {
    const fallback = '新会话';
    if (!item.title) return fallback;
    return item.title
        .replace(/\s*[·-]\s*(default|chatgpt|gemini|gpt-[\w.-]+|o\d(?:-mini)?)[\s]*$/ig, '')
        .trim() || fallback;
}

function getHistoryGroup(ts) {
    const value = Number(ts || 0);
    if (!Number.isFinite(value) || value <= 0) return 'earlier';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'earlier';

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
    if (value >= todayStart) return 'today';
    if (value >= yesterdayStart) return 'yesterday';
    return 'earlier';
}

function formatHistoryTime(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '未知时间';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderHistoryItem(item, highlightedSessionId = null) {
    const title = escapeHtml(getHistoryTitle(item));
    const time = escapeHtml(formatHistoryTime(getHistorySortTime(item)));
    const isCurrent = highlightedSessionId === item.sessionId;
    const agentIcon = getAgentIcon(item.agentId);
    const modeIcon = getModeIcon(item.mode);
    const agentName = escapeHtml(getAgentDisplayName(item.agentId));
    const modeName = item.mode === 'terminal' ? '终端会话' : 'UI 会话';
    const canViewTranscript = item.mode !== 'terminal' && item.hasTranscript !== false;
    const terminalTag = item.mode === 'terminal' && !item.active
        ? '<span class="history-mode-tag" title="终端模式不保存消息历史">终端无历史</span>'
        : '';
    const activeTag = item.active ? '<span class="history-running-tag" title="CLI 运行中">进行中</span>' : '';
    const interruptedTag = item.endedReason === 'server_restart'
        ? '<span class="history-mode-tag history-interrupted-tag" title="服务重启前会话被中断">重启中断</span>'
        : '';

    const menuActions = item.active
        ? `
      <button data-action="switch" data-session="${item.sessionId}">切换</button>
      <button data-action="rename" data-session="${item.sessionId}">重命名</button>
      <button data-action="stop" data-session="${item.sessionId}">停止</button>
    `
        : `
      <button data-action="view" data-session="${item.sessionId}" ${canViewTranscript ? '' : 'disabled title="终端模式无可读历史"'}>查看</button>
      <button data-action="rename" data-session="${item.sessionId}">重命名</button>
      <button data-action="delete" data-session="${item.sessionId}">删除</button>
    `;

    return `
    <div class="history-item ${isCurrent ? 'active' : ''}" data-session="${item.sessionId}">
      <div class="history-item-main" data-session="${item.sessionId}" data-active="${item.active ? '1' : '0'}" data-viewable="${canViewTranscript ? '1' : '0'}">
        <div class="history-title">${title}</div>
        <div class="history-meta-row">
          <span class="history-meta-icons">
            <span class="history-meta-icon" title="${agentName}">${agentIcon}</span>
            <span class="history-meta-icon" title="${modeName}">${modeIcon}</span>
            ${terminalTag}
            ${activeTag}
            ${interruptedTag}
          </span>
          <span class="history-meta">${time}</span>
        </div>
      </div>
      <button class="history-more-btn" title="更多">⋯</button>
      <div class="history-menu">
        ${menuActions}
      </div>
    </div>
  `;
}

function escapeHtml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getAgentIcon(agentId) {
    if (agentId === 'codex') return '<img src="/icons/openai-light.svg" alt="ChatGPT" width="14" height="14" class="agent-icon-img">';
    if (agentId === 'gemini') return '<img src="/icons/gemini-color.svg" alt="Gemini" width="14" height="14" class="agent-icon-img">';
    return '🤖';
}

function getModeIcon(mode) {
    return mode === 'terminal' ? '🖥️' : '💬';
}

async function fetchTranscript(sessionId, useCache = true) {
    if (useCache && transcriptCache.has(sessionId)) {
        return transcriptCache.get(sessionId);
    }
    const res = await fetch(`/api/history/${sessionId}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (useCache && data) {
        transcriptCache.set(sessionId, data);
    }
    return data;
}

async function openHistory(sessionId) {
    try {
        focusedSessionId = sessionId;
        renderHistoryList();
        const data = await fetchTranscript(sessionId, true);
        if (!data) {
            showToast('历史记录加载失败', 'error');
            return;
        }
        if ((data?.mode || '') === 'terminal') {
            showToast('终端模式不保存可回看的消息历史', 'info');
            return;
        }
        historyModeSessionId = sessionId;
        focusedSessionId = sessionId;
        isStartingSession = false;
        sessionMode = 'chat';
        currentView = 'chat';
        currentAgent = data.agentId || '';
        currentModel = data.modelId || 'default';
        renderChatMessages(data.messages || []);
        setAssistantPending(false);
        setInputEnabled(false);
        currentSessionId = null;
        activeSessionMeta = null;
        showAgentUI(false);
        updateSessionStatus();
        updateSessionActionButtons();
        showToast('正在查看历史记录（只读）', 'info');
    } catch (e) {
        showToast('历史记录加载失败', 'error');
    }
}

async function loadTranscriptIntoChat(sessionId) {
    hydratingTranscriptSessionId = sessionId;
    try {
        const data = await fetchTranscript(sessionId, false);
        if (!data) return;
        historyModeSessionId = null;
        renderChatMessages(data.messages || []);
        if (data.agentId) currentAgent = data.agentId;
        if (data.modelId) currentModel = data.modelId;
        updateSessionStatus();
    } catch {
        // 忽略
    } finally {
        if (hydratingTranscriptSessionId === sessionId) {
            hydratingTranscriptSessionId = null;
        }
        flushQueuedOutputAfterHydrating(sessionId);
    }
}

async function renameSession(sessionId) {
    const title = prompt('请输入会话名称');
    if (!title) return;
    const res = await fetch(`/api/history/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title })
    });
    if (!res.ok) {
        showToast('重命名失败', 'error');
        return;
    }
    if (transcriptCache.has(sessionId)) {
        const cached = transcriptCache.get(sessionId);
        if (cached) cached.title = title;
    }
    await loadActiveSessions();
    await loadHistory();
    showToast('已重命名', 'success');
}

async function deleteSession(sessionId) {
    if (!confirm('确定删除该历史记录吗？')) return;
    const res = await fetch(`/api/history/${sessionId}`, { method: 'DELETE' });
    if (!res.ok) {
        showToast('删除失败', 'error');
        return;
    }
    transcriptCache.delete(sessionId);
    await loadHistory();
    showToast('已删除', 'success');
}

function switchSession(sessionId) {
    if (!sessionId) return;
    if (sessionId === currentSessionId || sessionId === pendingSwitchSessionId) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
        pendingSwitchSessionId = sessionId;
        focusedSessionId = sessionId;
        renderHistoryList();
        ws.send(JSON.stringify({ type: 'switch_session', sessionId }));
    }
}

function stopSpecificSession(sessionId) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stop_session', sessionId }));
    }
}

function setInputEnabled(enabled) {
    const messageInput = document.getElementById('messageInput');
    if (messageInput) messageInput.disabled = !enabled;
}

function setConnectionStatus(connected) {
    const el = document.getElementById('connectionStatus');
    if (!el) return;
    el.textContent = connected ? '服务器已连接' : '服务器离线';
    el.classList.remove('online', 'offline');
    el.classList.add(connected ? 'online' : 'offline');
}

function updateSessionStatus() {
    const el = document.getElementById('sessionStatus');
    if (!el) return;

    el.classList.remove('running', 'idle', 'readonly');
    if (isStartingSession) {
        el.textContent = '会话启动中';
        el.classList.add('idle');
        updateChatModelBadge();
        return;
    }
    if (historyModeSessionId) {
        el.textContent = '历史会话（只读）';
        el.classList.add('readonly');
        updateChatModelBadge();
        return;
    }

    if (currentSessionId) {
        el.textContent = '会话进行中';
        el.classList.add('running');
    } else {
        el.textContent = '待开始新会话';
        el.classList.add('idle');
    }
    updateChatModelBadge();
}

function updateChatModelBadge() {
    const el = document.getElementById('chatModelBadge');
    if (!el) return;
    const { agentId, modelId, title } = getCenterBadgeMeta();
    const label = escapeHtml(title ? `${getAgentDisplayName(agentId)} · ${title}` : getSessionDisplayName(agentId, modelId));
    const icon = getAgentIcon(agentId);
    el.innerHTML = `
      <span class="chat-model-badge-inner">
        <span class="chat-model-badge-icon">${icon}</span>
        <span class="chat-model-badge-text">${label}</span>
      </span>
    `;
}

function updateSessionActionButtons() {
    const startBtn = document.getElementById('startSessionBtn');
    const stopBtn = document.getElementById('stopSessionBtn');
    if (!startBtn || !stopBtn) return;
    const running = Boolean(currentSessionId);
    startBtn.disabled = isStartingSession;
    startBtn.textContent = isStartingSession ? '启动中...' : '启动会话';
    startBtn.style.display = running ? 'none' : 'inline-flex';
    stopBtn.style.display = running ? 'inline-flex' : 'none';
}

function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleString();
}

// ========== WebSocket ==========
function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onopen = () => {
        isConnected = true;
        terminalRawBuffer = '';
        clearTerminalViewport();
        setConnectionStatus(true);
        ws.send(JSON.stringify({ type: 'resume' }));
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
    };

    ws.onclose = () => {
        isConnected = false;
        isStartingSession = false;
        setAssistantPending(false);
        setConnectionStatus(false);
        updateSessionStatus();
        updateSessionActionButtons();
        setTimeout(() => {
            if (!isConnected) {
                connectWebSocket();
            }
        }, 3000);
    };

    ws.onerror = () => { };
}

function handleMessage(msg) {
    switch (msg.type) {
        case 'output':
            if (msg.sessionId && currentSessionId && msg.sessionId !== currentSessionId) break;
            terminalRawBuffer += msg.data || '';
            if (terminalRawBuffer.length > 200000) {
                terminalRawBuffer = terminalRawBuffer.slice(-160000);
            }
            if (term) term.write(msg.data);
            const shouldRenderToChat = sessionMode === 'chat' && (!historyModeSessionId || historyModeSessionId === currentSessionId);
            if (shouldRenderToChat) {
                const targetSessionId = msg.sessionId || currentSessionId;
                if (hydratingTranscriptSessionId && hydratingTranscriptSessionId === targetSessionId) {
                    queueOutputWhileHydrating(targetSessionId, msg.data || '');
                } else {
                    appendAssistantChunkStream(msg.data, targetSessionId);
                }
            }
            break;
        case 'started':
            currentAgent = msg.agentId;
            currentModel = msg.modelId;
            currentSessionId = msg.sessionId;
            focusedSessionId = msg.sessionId;
            if (!recentUserLinesBySession.has(currentSessionId)) {
                recentUserLinesBySession.set(currentSessionId, []);
            }
            clearAssistantStreamState(currentSessionId);
            isStartingSession = false;
            historyModeSessionId = null;
            activeSessionMeta = {
                sessionId: msg.sessionId,
                agentId: msg.agentId,
                modelId: msg.modelId,
                createdAt: Date.now()
            };
            pendingSwitchSessionId = null;
            sessionMode = msg.mode === 'terminal' ? 'terminal' : 'chat';
            currentView = sessionMode;
            setSelectedAgent(msg.agentId, true);
            setPendingMode(sessionMode, true);
            showAgentUI(true);
            setInputEnabled(true);
            resetChatView();
            loadActiveSessions().then(renderHistoryList);
            if (pendingUserMessage) {
                const text = pendingUserMessage;
                pendingUserMessage = null;
                addUserMessage(text);
                if (sessionMode === 'chat') setAssistantPending(true);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'user_message', text }));
                }
            }
            break;
        case 'resumed':
            currentAgent = msg.agentId;
            currentModel = msg.modelId;
            currentSessionId = msg.sessionId;
            focusedSessionId = msg.sessionId;
            if (!recentUserLinesBySession.has(currentSessionId)) {
                recentUserLinesBySession.set(currentSessionId, []);
            }
            clearAssistantStreamState(currentSessionId);
            terminalRawBuffer = '';
            clearTerminalViewport();
            isStartingSession = false;
            historyModeSessionId = null;
            activeSessionMeta = {
                sessionId: msg.sessionId,
                agentId: msg.agentId,
                modelId: msg.modelId,
                createdAt: Date.now()
            };
            pendingSwitchSessionId = null;
            sessionMode = msg.mode === 'terminal' ? 'terminal' : 'chat';
            currentView = sessionMode;
            showAgentUI(true);
            setSelectedAgent(msg.agentId, true);
            setPendingMode(sessionMode, true);
            if (msg.files) {
                sessionFiles = msg.files;
                renderFileTree();
            }
            setInputEnabled(true);
            setAssistantPending(false);
            if (sessionMode === 'chat') {
                resetChatView();
                loadTranscriptIntoChat(msg.sessionId);
            }
            loadActiveSessions().then(renderHistoryList);
            break;
        case 'no_session':
            currentAgent = '';
            currentModel = '';
            currentSessionId = null;
            focusedSessionId = historyModeSessionId || null;
            activeSessionMeta = null;
            isStartingSession = false;
            pendingSwitchSessionId = null;
            clearAssistantStreamState();
            showAgentUI(false);
            setInputEnabled(!historyModeSessionId);
            setAssistantPending(false);
            break;
        case 'stopped':
            if (currentSessionId) {
                recentUserLinesBySession.delete(currentSessionId);
                clearAssistantStreamState(currentSessionId);
            }
            currentAgent = '';
            currentModel = '';
            currentSessionId = null;
            focusedSessionId = historyModeSessionId || null;
            activeSessionMeta = null;
            sessionFiles = [];
            isStartingSession = false;
            pendingSwitchSessionId = null;
            showAgentUI(false);
            setInputEnabled(!historyModeSessionId);
            setAssistantPending(false);
            loadActiveSessions().then(loadHistory);
            break;
        case 'exit':
            if (currentSessionId) {
                recentUserLinesBySession.delete(currentSessionId);
                clearAssistantStreamState(currentSessionId);
            }
            currentAgent = '';
            currentSessionId = null;
            focusedSessionId = historyModeSessionId || null;
            activeSessionMeta = null;
            isStartingSession = false;
            pendingSwitchSessionId = null;
            showAgentUI(false);
            showToast(msg.message || 'Agent 进程已退出', 'error');
            setInputEnabled(!historyModeSessionId);
            setAssistantPending(false);
            loadActiveSessions().then(loadHistory);
            break;
        case 'sessions':
            activeSessions = msg.sessions || [];
            renderHistoryList();
            break;
        case 'session_switched':
            currentAgent = msg.agentId;
            currentModel = msg.modelId;
            currentSessionId = msg.sessionId;
            focusedSessionId = msg.sessionId;
            if (!recentUserLinesBySession.has(currentSessionId)) {
                recentUserLinesBySession.set(currentSessionId, []);
            }
            clearAssistantStreamState(currentSessionId);
            terminalRawBuffer = '';
            clearTerminalViewport();
            isStartingSession = false;
            historyModeSessionId = null;
            activeSessionMeta = {
                sessionId: msg.sessionId,
                agentId: msg.agentId,
                modelId: msg.modelId,
                createdAt: Date.now()
            };
            pendingSwitchSessionId = null;
            sessionMode = msg.mode === 'terminal' ? 'terminal' : 'chat';
            currentView = sessionMode;
            showAgentUI(true);
            setInputEnabled(true);
            resetChatView();
            setAssistantPending(false);
            setSelectedAgent(msg.agentId, true);
            setPendingMode(sessionMode, true);
            if (msg.files) {
                sessionFiles = msg.files;
                renderFileTree();
            }
            if (sessionMode === 'chat') {
                loadTranscriptIntoChat(msg.sessionId);
            }
            loadActiveSessions().then(renderHistoryList);
            break;
        case 'session_stopped':
            recentUserLinesBySession.delete(msg.sessionId);
            clearAssistantStreamState(msg.sessionId);
            if (pendingSwitchSessionId === msg.sessionId) pendingSwitchSessionId = null;
            if (currentSessionId === msg.sessionId) {
                currentSessionId = null;
                focusedSessionId = historyModeSessionId || null;
                isStartingSession = false;
                showAgentUI(false);
                setInputEnabled(!historyModeSessionId);
                setAssistantPending(false);
            }
            loadActiveSessions().then(loadHistory);
            break;
        case 'detached':
            isStartingSession = false;
            pendingSwitchSessionId = null;
            focusedSessionId = historyModeSessionId || currentSessionId || null;
            clearAssistantStreamState(currentSessionId);
            showAgentUI(false);
            setInputEnabled(!historyModeSessionId);
            setAssistantPending(false);
            break;
        case 'file_added':
            sessionFiles = msg.files;
            renderFileTree();
            break;
        case 'file_list':
            sessionFiles = msg.files;
            renderFileTree();
            break;
        case 'error':
            isStartingSession = false;
            pendingSwitchSessionId = null;
            showToast(msg.message, 'error');
            setAssistantPending(false);
            break;
    }
    updateSessionStatus();
    updateSessionActionButtons();
    updatePrechatComposerState();
}

// ========== Agent 操作 ==========
function startPrechatConversation() {
    const prechatInput = document.getElementById('prechatInput');
    const text = (prechatInput?.value || '').trim();
    if (!text) return;
    historyModeSessionId = null;
    lastUserMessageText = text;
    pendingUserMessage = text;
    sessionMode = pendingMode;
    currentAgent = getSelectedAgentId();
    currentModel = 'default';
    updateChatModelBadge();
    if (prechatInput) prechatInput.value = '';
    if (sessionMode === 'chat') setAssistantPending(true);
    startSelectedSession();
}

function startSelectedSession() {
    if (currentSessionId || isStartingSession) return;
    if (historyModeSessionId) {
        historyModeSessionId = null;
        resetChatView();
    }
    const agentId = getSelectedAgentId();
    if (!agentId) {
        showToast('请先选择 Agent', 'error');
        return;
    }
    isStartingSession = true;
    terminalRawBuffer = '';
    clearTerminalViewport();
    currentView = sessionMode;
    setView(currentView);
    updateSessionStatus();
    updateSessionActionButtons();
    startAgent(agentId, getSelectedModelId());
}

function startAgent(agentId, modelId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        connectWebSocket();
        const waitForOpen = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                clearInterval(waitForOpen);
                ws.send(JSON.stringify({ type: 'start', agentId, modelId, mode: sessionMode }));
            }
        }, 200);
        return;
    }
    ws.send(JSON.stringify({ type: 'start', agentId, modelId, mode: sessionMode }));
}

function getSelectedModelId() {
    return 'default';
}

function getSelectedAgentId() {
    return selectedAgentId || 'codex';
}

function stopAgent() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stop' }));
    }
}

function showAgentUI(active) {
    const bottomBar = document.getElementById('bottomBar');
    const terminalEl = document.getElementById('terminal');
    const chatView = document.getElementById('chatView');
    const prechatScreen = document.getElementById('prechatScreen');
    const chatStream = document.getElementById('chatStream');

    if (active) {
        setBottomBarVisible(sessionMode !== 'terminal');
        if (sessionMode === 'terminal') {
            document.body.classList.add('terminal-mode');
            terminalEl.style.display = 'block';
            chatView.style.display = 'none';
            if (!term) initTerminal();
        } else {
            document.body.classList.remove('terminal-mode');
            terminalEl.style.display = 'none';
            chatView.style.display = 'flex';
            if (prechatScreen) prechatScreen.style.display = 'none';
            if (chatStream) chatStream.style.display = 'flex';
        }
    } else {
        setBottomBarVisible(false);
        if (isStartingSession && sessionMode === 'terminal') {
            document.body.classList.add('terminal-mode');
            terminalEl.style.display = 'block';
            chatView.style.display = 'none';
            if (!term) initTerminal();
        } else {
            document.body.classList.remove('terminal-mode');
            terminalEl.style.display = 'none';
            chatView.style.display = 'flex';
            if (historyModeSessionId) {
                if (prechatScreen) prechatScreen.style.display = 'none';
                if (chatStream) chatStream.style.display = 'flex';
            } else {
                if (prechatScreen) prechatScreen.style.display = 'flex';
                if (chatStream) chatStream.style.display = 'none';
            }
            if (term) {
                term.dispose();
                term = null;
                fitAddon = null;
            }
        }
        renderFileTree();
    }
    updateSessionActionButtons();
    updateSessionStatus();
}

function setBottomBarVisible(visible) {
    const bottomBar = document.getElementById('bottomBar');
    if (!bottomBar) return;

    if (bottomBarHideTimer) {
        clearTimeout(bottomBarHideTimer);
        bottomBarHideTimer = null;
    }

    if (visible) {
        bottomBar.style.display = 'block';
        requestAnimationFrame(() => {
            bottomBar.classList.add('active');
        });
        return;
    }

    bottomBar.classList.remove('active');
    bottomBarHideTimer = setTimeout(() => {
        if (!bottomBar.classList.contains('active')) {
            bottomBar.style.display = 'none';
        }
    }, 260);
}

// ========== 文件树 ==========
function renderFileTree() {
    const tree = document.getElementById('fileTree');

    if (sessionFiles.length === 0) {
        tree.innerHTML = '<div class="file-tree-empty">暂无文件<br>可拖拽文件到此处</div>';
        updateUploadButtonBadge();
        return;
    }

    tree.innerHTML = sessionFiles.map(f => `
    <div class="file-item" title="${f.path}">
      <span class="file-icon">${getFileIcon(f.name)}</span>
      <span class="file-name">${f.name}</span>
      <span class="file-ref" data-path="${f.path}" title="插入 @ 引用">@</span>
    </div>
  `).join('');

    // 点击 @ 按钮插入引用
    tree.querySelectorAll('.file-ref').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const input = currentSessionId
                ? document.getElementById('messageInput')
                : document.getElementById('prechatInput');
            if (!input) return;
            const path = btn.dataset.path;
            input.value += (input.value.endsWith(' ') || input.value === '' ? '' : ' ') + `@${path} `;
            input.focus();
            showToast(`已插入文件引用: ${path}`, 'info');
        });
    });
    updateUploadButtonBadge();
}

function getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const icons = {
        png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️', bmp: '🖼️',
        js: '📜', ts: '📜', py: '🐍', java: '☕', c: '⚙️', cpp: '⚙️', go: '🔵', rs: '🦀',
        html: '🌐', css: '🎨', json: '📋', xml: '📋', yaml: '📋', yml: '📋',
        md: '📝', txt: '📝', pdf: '📄', doc: '📄', docx: '📄',
        xls: '📊', xlsx: '📊', csv: '📊',
        zip: '📦', tar: '📦', gz: '📦',
        sh: '🔧', sql: '🗃️'
    };
    return icons[ext] || '📎';
}

// ========== xterm.js ==========
function initTerminal() {
    term = new Terminal({
        theme: {
            background: '#0d1117', foreground: '#e6edf3', cursor: '#58a6ff', cursorAccent: '#0d1117',
            selectionBackground: 'rgba(88, 166, 255, 0.3)',
            black: '#484f58', red: '#f85149', green: '#3fb950', yellow: '#d29922',
            blue: '#58a6ff', magenta: '#bc8cff', cyan: '#76e3ea', white: '#e6edf3',
            brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
            brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#b3f0ff', brightWhite: '#f0f6fc'
        },
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
        fontSize: 14, lineHeight: 1.3, cursorBlink: true, cursorStyle: 'bar', scrollback: 10000,
        allowProposedApi: true
    });

    fitAddon = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(document.getElementById('terminal'));
    if (terminalRawBuffer) {
        term.write(terminalRawBuffer);
    }

    setTimeout(() => {
        fitAddon.fit();
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
    }, 100);

    term.onData((data) => {
        if (shouldIgnoreTerminalInput(data)) return;
        if (currentSessionId && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', data }));
        }
    });

    term.onResize(({ cols, rows }) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
    });
}

function clearTerminalViewport() {
    if (!term) return;
    term.clear();
    term.write('\x1b[2J\x1b[H');
}

function shouldIgnoreTerminalInput(data) {
    const raw = String(data || '');
    if (!raw) return true;
    if (/^(?:\x1b\[(?:\?|>)[0-9;]*c)+$/.test(raw)) return true;
    if (/^(?:[0-9]+(?:;[0-9]+)*c)+$/.test(raw) && raw.length <= 48) return true;
    return false;
}

// ========== 消息发送 ==========
function sendMessage() {
    const input = document.getElementById('messageInput');
    const text = input.value.trim();
    if (!text) return;
    lastUserMessageText = text;

    hideAtPopup();

    if (historyModeSessionId) {
        showToast('当前为历史记录视图，无法发送', 'error');
        return;
    }

    if (!currentSessionId) {
        const agentId = getSelectedAgentId();
        const modelId = getSelectedModelId();
        if (!agentId) {
            showToast('请先选择 Agent', 'error');
            return;
        }
        pendingUserMessage = text;
        if (sessionMode === 'chat') setAssistantPending(true);
        if (!isStartingSession) {
            isStartingSession = true;
            terminalRawBuffer = '';
            clearTerminalViewport();
            updateSessionStatus();
            updateSessionActionButtons();
            startAgent(agentId, modelId);
        }
    } else {
        addUserMessage(text);
        if (sessionMode === 'chat') setAssistantPending(true);
        // 发送用户消息到后端（由后端写入终端）
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'user_message', text }));
        }
    }

    input.value = '';
    input.style.height = 'auto';
}

// ========== 文件上传 ==========
async function handleFileUpload(e) {
    const files = e.target.files || e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    await uploadFiles(files);
    document.getElementById('fileInput').value = '';
}

async function uploadFiles(files) {
    const formData = new FormData();
    for (const file of files) {
        formData.append('files', file);
    }

    try {
        showToast('正在上传文件...', 'info');
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();

        if (data.success) {
            data.files.forEach(file => {
                // 添加到会话文件列表
                sessionFiles.push(file);
                // 通知后端
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'add_file',
                        filePath: file.path,
                        fileName: file.name
                    }));
                }
            });
            renderFileTree();
            showToast(`${data.files.length} 个文件上传成功`, 'success');
        } else {
            showToast(data.error || '上传失败', 'error');
        }
    } catch (err) {
        showToast('上传失败: ' + err.message, 'error');
    }
}

function handlePasteUpload(e) {
    const items = e.clipboardData?.items || [];
    const files = [];
    for (const item of items) {
        if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file) files.push(file);
        }
    }
    if (files.length > 0) {
        e.preventDefault();
        uploadFiles(files);
    }
}

function updateUploadButtonBadge() {
    const buttons = Array.from(document.querySelectorAll('[data-upload-btn]'));
    if (buttons.length === 0) return;
    buttons.forEach(btn => {
        if (sessionFiles.length > 0) {
            btn.classList.add('has-files');
            btn.dataset.count = String(sessionFiles.length > 99 ? '99+' : sessionFiles.length);
            btn.title = `上传文件/图片（当前 ${sessionFiles.length} 个）`;
        } else {
            btn.classList.remove('has-files');
            btn.removeAttribute('data-count');
            btn.title = '上传文件/图片';
        }
    });
}

// ========== 拖拽上传 ==========
function setupDragDrop() {
    const overlay = document.getElementById('dragOverlay');
    let dragCounter = 0;

    document.addEventListener('dragenter', (e) => { e.preventDefault(); dragCounter++; overlay.style.display = 'flex'; });
    document.addEventListener('dragleave', (e) => { e.preventDefault(); dragCounter--; if (dragCounter === 0) overlay.style.display = 'none'; });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
        e.preventDefault(); dragCounter = 0; overlay.style.display = 'none';
        if (e.dataTransfer.files.length > 0) handleFileUpload({ target: { files: e.dataTransfer.files } });
    });
}

// ========== Toast ==========
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// ========== 自动连接 ==========
connectWebSocket();
