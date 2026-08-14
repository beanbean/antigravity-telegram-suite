const OriginalCDP = require('chrome-remote-interface');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { t } = require('./i18n');


// ===== MULTI-WINDOW SUPPORT =====
let preferredTargetId = null;
let windowCache = [];

// Track the last successfully resolved conversation UUID.
// Set by snapshotChatState after a message is sent, used by getFullLatestResponse
// so /latest doesn't have to guess which thread to read from.
let lastResolvedThreadId = null;
function getLastResolvedThreadId() { return lastResolvedThreadId; }
function setLastResolvedThreadId(id) { lastResolvedThreadId = id; }

// Hook for external subscribers (e.g., TaskWatcher) to be notified when thread ID changes
let _onThreadResolved = null;
function setOnThreadResolved(cb) { _onThreadResolved = cb; }
function _notifyThreadResolved(threadId) {
    if (_onThreadResolved && threadId) _onThreadResolved(threadId);
}

/**
 * Shared target resolver — fetches CDP targets, filters, and sorts.
 * If a preferred window is set, that window is prioritised.
 * @param {number} port - CDP debugging port
 * @param {boolean} includeIframe - whether to include iframe/webview types
 * @returns {Promise<Array>} sorted array of CDP target objects
 */
const DriverFactory = require('./drivers');
const SUBMIT_ACTION_TEXTS = [
    'submit', 'send', 'send message', 'gönder',
    '提交', '发送', '发送消息'
];
const PENDING_ACTION_TEXTS = [
    'run', 'accept', 'allow', 'continue', 'retry',
    'çalıştır', 'kabul et', 'izin ver', 'devam et', 'yeniden dene',
    '运行', '接受', '允许', '继续', '重试'
];

function isLikelyClassicIDETarget(target = {}) {
    const text = `${target.title || ''} ${target.url || ''}`.toLowerCase();
    return (
        text.includes('antigravity ide') ||
        text.includes('classic ide') ||
        text.includes('vscode-webview') ||
        text.includes('vscode-') ||
        text.includes('monaco')
    );
}

function parseSelectableSlashCommand(prompt) {
    const match = String(prompt || '').trim().match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/);
    if (!match) return null;
    const command = match[1].toLowerCase();
    if (command !== 'goal') return null;
    return { command, args: (match[2] || '').trim() };
}

function getSelectableSlashCommandForTarget(prompt, target = {}) {
    const preferredApp = DriverFactory.getDriver().appType;
    if (preferredApp === 'ide' || isLikelyClassicIDETarget(target)) return null;
    return parseSelectableSlashCommand(prompt);
}

// Cache for the active workspace name, refreshed on each resolveTargets call
let activeWorkspaceName = null;
const threadNameToIdCache = new Map();

/**
 * Resolves a conversation UUID by its thread name.
 * Checks cache first, then scans file system overview.txt headers.
 */
function findConversationIdByTitle(threadName) {
    if (!threadName) return null;

    const isStandalone = DriverFactory.getDriver().appType === 'standalone';

    if (isStandalone && threadNameToIdCache.has(threadName)) {
        return threadNameToIdCache.get(threadName);
    }

    try {
        const appDataName = DriverFactory.getDriver().appDataName;
        const brainPath = path.join(os.homedir(), '.gemini', appDataName, 'brain');
        if (!fs.existsSync(brainPath)) return null;

        const dirs = fs.readdirSync(brainPath, { withFileTypes: true });
        
        // Sort by mtime to search recent threads first — check BOTH overview.txt AND transcript.jsonl
        const sortedDirs = dirs
            .filter(d => d.isDirectory())
            .map(d => {
                const overviewPath = path.join(brainPath, d.name, '.system_generated', 'logs', 'overview.txt');
                const transcriptPath = path.join(brainPath, d.name, '.system_generated', 'logs', 'transcript.jsonl');
                let mtime = 0;
                let logPath = null;
                try { if (fs.existsSync(transcriptPath)) { mtime = fs.statSync(transcriptPath).mtimeMs; logPath = transcriptPath; } } catch (_) {}
                if (!logPath) { try { if (fs.existsSync(overviewPath)) { mtime = fs.statSync(overviewPath).mtimeMs; logPath = overviewPath; } } catch (_) {} }
                return { name: d.name, logPath, mtime };
            })
            .sort((a, b) => b.mtime - a.mtime);

        const unescapeHtml = (str) => {
            return (str || '')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&#x27;/g, "'");
        };
        const normalize = (s) => (s || '').toLowerCase().replace(/[-_]/g, ' ').trim();
        const searchName = normalize(unescapeHtml(threadName));

        // For short search names, require stricter match
        const minMatchLen = Math.min(15, searchName.length);

        for (const dir of sortedDirs) {
            if (!dir.logPath) continue;
            
            try {
                // Read first chunk of file (enough to get conversation title and first user message)
                const fd = fs.openSync(dir.logPath, 'r');
                const buffer = Buffer.alloc(6000);
                const bytesRead = fs.readSync(fd, buffer, 0, 6000, 0);
                fs.closeSync(fd);
                
                const content = buffer.toString('utf8', 0, bytesRead);
                const lines = content.split('\n');
                
                for (const line of lines) {
                    if (!line.includes('"source":"USER_EXPLICIT"')) continue;
                    try {
                        const entry = JSON.parse(line);
                        const match = entry.content.match(/<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/);
                        if (match) {
                            let firstMsg = normalize(match[1]);
                            if (firstMsg.length > 80) firstMsg = firstMsg.substring(0, 80);
                            
                            // Check if thread title matches first user message
                            // IDE generates titles from the first message, so they overlap
                            const words1 = searchName.split(/\s+/).filter(w => w.length > 2);
                            const words2 = firstMsg.split(/\s+/).filter(w => w.length > 2);
                            const intersect = words1.filter(w => words2.includes(w));
                            const overlapRatio = (words1.length > 0 && words2.length > 0) ? (intersect.length / Math.min(words1.length, words2.length)) : 0;
                            
                            let isMatch = false;
                            
                            if (isStandalone) {
                                const hasLongCommonSub = () => {
                                    for (let len = 12; len >= 8; len--) {
                                        for (let i = 0; i <= searchName.length - len; i++) {
                                            const sub = searchName.substring(i, i + len);
                                            if (firstMsg.includes(sub)) return true;
                                        }
                                    }
                                    return false;
                                };
                                
                                isMatch = firstMsg.includes(searchName.substring(0, minMatchLen)) || 
                                          searchName.includes(firstMsg.substring(0, minMatchLen)) ||
                                          (words1.length >= 2 && words2.length >= 2 && overlapRatio >= 0.5) ||
                                          hasLongCommonSub();
                            } else {
                                isMatch = firstMsg.includes(searchName.substring(0, minMatchLen)) || 
                                          searchName.includes(firstMsg.substring(0, minMatchLen)) ||
                                          (words1.length >= 2 && words2.length >= 2 && overlapRatio >= 0.5);
                            }

                            if (isMatch) {
                                if (isStandalone) {
                                    threadNameToIdCache.set(threadName, dir.name);
                                    if (threadNameToIdCache.size > 500) { threadNameToIdCache.delete(threadNameToIdCache.keys().next().value); }
                                }
                                return dir.name;
                            }
                        }
                    } catch (e) {}
                    break; // Only check the first USER_EXPLICIT
                }
            } catch (e) {}
        }
    } catch (e) {
        console.debug('[findConversationIdByTitle] Error:', e.message);
    }
    
    return null;
}

async function resolveTargets(port, includeIframe = true) {
    const raw = await httpGet(`http://127.0.0.1:${port}/json`);
    const targets = JSON.parse(raw);
    const typeFilter = includeIframe
        ? t => (t.type === 'page' || t.type === 'iframe' || t.type === 'webview')
        : t => (t.type === 'page' || t.type === 'webview');
    const candidates = targets.filter(t => typeFilter(t) &&
        t.webSocketDebuggerUrl &&
        !t.url.includes('devtools://') &&
        !(t.title && t.title.includes('Launchpad')) &&
        t.title !== 'Manager');

    const preferredApp = DriverFactory.getDriver().appType;

    candidates.sort((a, b) => {
        // Preferred target by ID always wins (set via /window command)
        if (preferredTargetId) {
            if (a.id === preferredTargetId) return -1;
            if (b.id === preferredTargetId) return 1;
        }

        // Prioritize based on preferred app ('agent' vs 'ide')
        const aIsAgent = a.url && (a.url.includes('/c/') || a.url.includes('tab=') || (a.url.includes('127.0.0.1') && !a.url.includes('vscode-')));
        const bIsAgent = b.url && (b.url.includes('/c/') || b.url.includes('tab=') || (b.url.includes('127.0.0.1') && !b.url.includes('vscode-')));

        if (preferredApp === 'agent') {
            if (aIsAgent && !bIsAgent) return -1;
            if (!aIsAgent && bIsAgent) return 1;
        } else if (preferredApp === 'ide') {
            if (!aIsAgent && bIsAgent) return -1;
            if (aIsAgent && !bIsAgent) return 1;
        }

        // Dynamic fallback: prefer the target matching the active workspace
        if (activeWorkspaceName) {
            const normalize = (s) => (s || '').toLowerCase().replace(/[-_]/g, ' ');
            const searchName = normalize(activeWorkspaceName);
            const aMatch = normalize(a.title).includes(searchName) ? 1 : 0;
            const bMatch = normalize(b.title).includes(searchName) ? 1 : 0;
            if (aMatch !== bMatch) return bMatch - aMatch;
        }
        return 0;
    });

    return candidates;
}



/**
 * List all available IDE windows for the /window command.
 */
async function listWindows(port) {
    const targets = await resolveTargets(port, false);
    windowCache = targets.map(t => ({
        id: t.id,
        title: t.title || 'Untitled',
        url: t.url,
        isPreferred: preferredTargetId ? t.id === preferredTargetId : false
    }));
    return windowCache;
}

function setPreferredWindow(id) {
    preferredTargetId = id;
}

function getPreferredWindow() {
    if (!preferredTargetId) return null;
    const match = windowCache.find(w => w.id === preferredTargetId);
    return match ? match.title : preferredTargetId;
}

function getPreferredTargetId() {
    return preferredTargetId;
}

function getCachedWindows() {
    return windowCache;
}


const CHAT_EXTRACT_EXPR = `(() => {
    ${DriverFactory.getDriver().getLocatorsScript()}
    return (function() {
        let extractedText = "";
        try {
            // Use the centralized locator to find the active conversation
            const container = AG_UI.getVisibleChatContainer();
            
            function cleanText(text) {
                if (!text) return "";
                text = text.replace(/Ask anything.*?for workflows/gi, '');
                text = text.replace(/Ask anything, @ to mention, \\/ for actions/gi, '');
                text = text.replace(/0 Files With Changes/g, '');
                text = text.replace(/Review Changes/g, '');
                text = text.replace(/\\bReview\\b/g, '');
                text = text.replace(/\\d+\\s+file[s]?\\s+changed[\\s\\+\\-\\d]*>?/gi, '');
                text = text.replace(/Gemini[\\s\\d\\.]+Pro[\\s]*\\([^)]*\\)/gi, '');
                text = text.replace(/Claude[\\s\\w\\.]+\\([^)]*\\)/gi, '');
                text = text.replace(/GPT[\\s\\w\\.]+\\([^)]*\\)/gi, '');
                text = text.replace(/\\bSend\\b\\s*\\b(mic)?\\b/gi, '');
                text = text.replace(/\\bmic\\b/gi, '');
                text = text.replace(/Worked for \\d+s/gi, '');
                // Removed aggressive time stripping that was destroying valid agent times like 20:00
                // text = text.replace(/(?<!\\d)\\d{1,2}:\\d{2}(?:\\s*(?:AM|PM))?(?!\\d)/ig, '');
                text = text.replace(/Thinking.../g, "").replace(/Gelişim App Dev/g, "");

                // Strip out file upload system prompts injected by telegram-suite
                text = text.replace(/\\[System: The user has uploaded[\\s\\S]*?Use the tool!\\]/g, '');
                text = text.replace(/User's message:\\s*/gi, '');

                text = text.replace(/^\\s*(Plan|Execute|Review|Task|Walkthrough|Implementation Plan)\\s*$/gm, '');
                text = text.replace(/undo/g, '');
                text = text.replace(/chevron_right/g, '');
                text = text.replace(/chevron_left/g, '');
                text = text.replace(/content_copy/g, '');
                text = text.replace(/thumb_up/g, '');
                text = text.replace(/thumb_down/g, '');
                text = text.replace(/Files Modified[\\s\\n]*(\\d+)[\\s\\n]*([a-zA-Z0-9_\\-\\.]+)[\\s\\n]*\\+([0-9]+)[\\s\\n]*\\-([0-9]+)/gi, "\\n[📦 Files Modified: $2 (+$3, -$4)]\\n");
                text = text.replace(/\\n{3,}/g, '\\n\\n');
                return text.trim();
            }

            function nodeToMd(node) {
                if (node.nodeType === 3) return node.textContent;
                if (node.nodeType !== 1) return '';
                
                let tag = node.tagName.toLowerCase();
                if (tag === 'style' || tag === 'script') return '';
                if (tag === 'img') {
                    const src = node.currentSrc || node.src || node.getAttribute('src') || '';
                    if (!src) return '';
                    const alt = (node.getAttribute('alt') || node.getAttribute('title') || 'image').replace(/[\\]\\r\\n]/g, ' ').trim() || 'image';
                    return '\\n![' + alt + '](' + src + ')\\n';
                }
                if (node.classList && node.classList.contains('code-block')) {
                    let lines = Array.from(node.querySelectorAll('.code-line'));
                    let code = lines.map(l => l.textContent.replace(/\\u00a0/g, ' ')).join('\\n');
                    return '\\n\`\`\`\\n' + code + '\\n\`\`\`\\n';
                }
                if (tag === 'pre') {
                    let codeNode = node.querySelector('code');
                    let lang = '';
                    if (codeNode) {
                        let match = codeNode.className.match(/language-([a-z0-9]+)/i);
                        if (match) lang = match[1];
                        return '\\n\`\`\`' + lang + '\\n' + codeNode.textContent + '\\n\`\`\`\\n';
                    }
                    return '\\n\`\`\`\\n' + node.textContent + '\\n\`\`\`\\n';
                }
                if (tag === 'table') {
                    let md = '\\n\`\`\`text\\n';
                    let rows = Array.from(node.querySelectorAll('tr'));
                    rows.forEach((row, i) => {
                        let cells = Array.from(row.querySelectorAll('td, th')).map(c => c.textContent.trim().replace(/\\|/g, '\\\\|'));
                        md += '| ' + cells.join(' | ') + ' |\\n';
                        if (i === 0 && row.querySelector('th')) {
                            md += '|' + cells.map(() => '---').join('|') + '|\\n';
                        }
                    });
                    return md + '\`\`\`\\n';
                }
                
                let md = '';
                for (let child of node.childNodes) {
                    md += nodeToMd(child);
                }
                
                if (tag === 'strong' || tag === 'b') return '**' + md.trim() + '** ';
                if (tag === 'em' || tag === 'i') return '_' + md.trim() + '_ ';
                if (tag === 'code') return '\`' + md.trim() + '\`';
                if (tag === 'a') return '[' + md.trim() + '](' + node.href + ')';
                if (tag === 'p' || tag === 'div') return md + '\\n';
                if (tag === 'li') return '- ' + md + '\\n';
                if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') return '\\n### ' + md.trim() + '\\n';
                if (tag === 'span') return md.trim() + ' ';
                
                const inlineTags = ['a', 'strong', 'b', 'em', 'i', 'code', 'span', '#text'];
                if (!inlineTags.includes(tag) && tag !== 'p' && tag !== 'div' && tag !== 'li' && !tag.match(/^h[1-6]$/)) {
                    return md.trim() + '\\n';
                }
                
                return md;
            }

            if (container) {
                const listSelector = '.relative.flex.flex-col.gap-y-3.px-4, .monaco-list-rows, [class*="message-list"], .chat-messages, [data-testid*="message-list"]';
                const list = container.matches && container.matches(listSelector) ? container : (container.querySelector ? container.querySelector(listSelector) : null);
                if (list) {
                    const msgs = [];
                    for (let child of list.children) {
                        let clone = child.cloneNode(true);
                        
                        Array.from(clone.querySelectorAll('style, .material-icons, .material-symbols-outlined, .material-symbols-rounded, .google-symbols, .codicon, [class*="icon"]')).forEach(el => el.remove());
                        
                        // Use centralized logic to remove Thought blocks
                        AG_UI.removeThoughtBlocks(clone);
                        
                        Array.from(clone.querySelectorAll('button, [role="button"]')).forEach(el => {
                            const t = el.textContent.trim().toLowerCase();
                            // Remove known action buttons
                            if (t === 'apply' || t === 'copy' || t === 'run' || t === 'accept' || t === 'reject' || t === 'review changes' || t === 'cancel' || t === 'submit' || t === 'insert' || t === 'terminal' || t.startsWith('apply ')) {
                                el.remove();
                            } else {
                                // Keep context pills/file references, format them as code
                                const txt = el.textContent.trim();
                                if (txt) {
                                    const codeNode = document.createElement('code');
                                    codeNode.textContent = txt;
                                    el.parentNode.replaceChild(codeNode, el);
                                } else {
                                    el.remove();
                                }
                            }
                        });
                        
                        let userNodes = Array.from(clone.querySelectorAll('.bg-input, [data-message-author="user"], [class*="group/user-input-step"], .interactive-request, .chat-request'));
                        if (userNodes.length === 0 && clone.className && (clone.className.includes('user-message') || clone.className.includes('interactive-request') || clone.className.includes('chat-request') || clone.className.includes('user-input'))) {
                            userNodes = [clone];
                        }
                        
                        if (userNodes.length > 0) {
                            let isEntireRowUser = false;
                            userNodes.forEach(un => {
                                let uText = cleanText(un.innerText || un.textContent);
                                if (uText) msgs.push("👤 User:\\n" + uText);
                                if (un === clone) {
                                    isEntireRowUser = true;
                                } else {
                                    un.remove(); // Remove user text from clone so agent text is left
                                }
                            });
                            
                            if (!isEntireRowUser) {
                                let aText = cleanText(nodeToMd(clone));
                                if (aText) msgs.push("🤖 Agent:\\n" + aText);
                            }
                        } else {
                            let aText = cleanText(nodeToMd(clone));
                            if (aText) msgs.push("🤖 Agent:\\n" + aText);
                        }
                    }
                    // Clean up language names left behind by code block headers
                    extractedText = msgs.join('\\n\\n').replace(/^(javascript|python|html|css|bash|json|markdown)\\n/gm, '');
                } else {
                    // Fallback for Standalone 2.0 or unknown DOM structures
                    const messageNodes = Array.from(container.querySelectorAll('.prose, .markdown-body, [data-message-author], .chat-message, [class*="message-bubble"]'));
                    if (messageNodes.length > 0) {
                        const msgs = [];
                        messageNodes.forEach(child => {
                            let clone = child.cloneNode(true);
                            Array.from(clone.querySelectorAll('style, .material-icons, .material-symbols-outlined, .material-symbols-rounded, .google-symbols, .codicon, [class*="icon"]')).forEach(el => el.remove());
                            
                            Array.from(clone.querySelectorAll('button, [role="button"]')).forEach(el => {
                                const t = el.textContent.trim().toLowerCase();
                                if (t === 'apply' || t === 'copy' || t === 'run' || t === 'accept' || t === 'reject' || t === 'review changes' || t === 'cancel' || t === 'submit' || t === 'insert' || t === 'terminal' || t.startsWith('apply ')) {
                                    el.remove();
                                } else {
                                    const txt = el.textContent.trim();
                                    if (txt) {
                                        const codeNode = document.createElement('code');
                                        codeNode.textContent = txt;
                                        el.parentNode.replaceChild(codeNode, el);
                                    } else {
                                        el.remove();
                                    }
                                }
                            });

                            let isUser = false;
                            let curr = child;
                            while (curr && curr !== container) {
                                if (curr.getAttribute('data-message-author') === 'user' || (curr.className && (curr.className.includes('user-message') || curr.className.includes('bg-input') || curr.className.includes('user-input')))) {
                                    isUser = true;
                                    break;
                                }
                                curr = curr.parentElement;
                            }

                            AG_UI.removeThoughtBlocks(clone);
                            let text = cleanText(nodeToMd(clone));
                            if (text) {
                                let prefixed = (isUser ? "👤 User:\\n" : "🤖 Agent:\\n") + text;
                                if (!msgs.includes(prefixed)) msgs.push(prefixed);
                            }
                        });
                        extractedText = msgs.join('\\n\\n');
                    } else {
                        // Last resort: clone container and strip interactive/layout elements
                        let clone = container.cloneNode(true);
                        Array.from(clone.querySelectorAll('style, script, .material-icons, .material-symbols-outlined, .material-symbols-rounded, .google-symbols, .codicon, [class*="icon"]')).forEach(el => el.remove());
                        Array.from(clone.querySelectorAll('button, input, textarea, nav, header, [role="navigation"], [data-project-card], .convo-pill')).forEach(el => el.remove());
                        extractedText = cleanText(clone.innerText || clone.textContent || "");
                    }
                }
            }
        } catch(e) {}
        return String(extractedText);
    })();
})()`;

function withTimeout(promise, ms, errorMsg) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(errorMsg || `Operation timed out after ${ms}ms`));
        }, ms);
    });
    return Promise.race([
        promise,
        timeoutPromise
    ]).finally(() => {
        clearTimeout(timeoutId);
    });
}

const CDP = async (options) => {
    // 1. Connection Timeout
    const client = await withTimeout(OriginalCDP(options), 5000, "CDP Connect Timeout");
    
    // 2. Global CDP Command Timeout
    // When IDE freezes, ANY CDP command (like Runtime.enable, Runtime.evaluate, etc) can hang indefinitely.
    // By wrapping client.send, we enforce a global timeout for all operations.
    if (typeof client.send === 'function') {
        const originalSend = client.send.bind(client);
        client.send = async (method, params) => {
            // Provide larger timeouts for certain operations that might legitimately take longer
            let timeoutMs = 8000;
            if (method.includes('captureScreenshot')) timeoutMs = 15000;
            if (method.includes('Runtime.evaluate') && params?.awaitPromise) timeoutMs = 12000;
            
            return await withTimeout(originalSend(method, params), timeoutMs, `CDP ${method} Timeout`);
        };
    }

    return client;
};

function httpGet(url, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', err => reject(err));
        
        req.setTimeout(timeoutMs, () => {
            req.destroy();
            reject(new Error('HTTP request timed out'));
        });
    });
}

/**
 * Snapshot the current chat state so subsequent getLatestAgentResponse
 * calls only return text that appeared AFTER this snapshot.
 */
/**
 * Snapshot the current chat state for diff tracking.
 * DOM fallback uses globalLastChatState.
 */
async function snapshotChatState(port, specificTargetId = null, threadName = null) {
    lastResolvedThreadId = null; // ALWAYS clear stale cache before attempting to anchor

    // Strategy 1: If we have a thread name, resolve directly via filesystem
    // This is the most reliable path — used after /agents_N thread switching
    if (threadName) {
        const resolvedId = findConversationIdByTitle(threadName);
        if (resolvedId) {
            const appDataName = DriverFactory.getDriver().appDataName;
            const logsDir = path.join(os.homedir(), '.gemini', appDataName, 'brain', resolvedId, '.system_generated', 'logs');
            const hasLogs = fs.existsSync(path.join(logsDir, 'overview.txt')) || fs.existsSync(path.join(logsDir, 'transcript.jsonl'));
            if (hasLogs) {
                lastResolvedThreadId = resolvedId;
                _notifyThreadResolved(resolvedId);
                console.log(`[snapshot] Anchored via threadName "${threadName}" → ${resolvedId}`);
                return;
            }
        }
        console.log(`[snapshot] threadName "${threadName}" could not be resolved via findConversationIdByTitle — trying DOM snippet`);
    }
    
    // Strategy 1.5: Extract chat content from IDE DOM using CHAT_EXTRACT_EXPR (same
    // approach as _domLatestExtraction), then find a unique snippet in transcripts.
    if (threadName && specificTargetId) {
        try {
            const candidates = await resolveTargets(port, true);
            const targetCandidates = candidates.filter(c => c.id === specificTargetId);
            // Also include iframe/webview variants that belong to the same window
            if (targetCandidates.length === 0) targetCandidates.push(...candidates.slice(0, 2));
            
            for (const target of targetCandidates) {
                try {
                    const client = await withTimeout(CDP({ target: target.webSocketDebuggerUrl }), 3000, "CDP timeout");
                    const { Runtime } = client;
                    await Runtime.enable();
                    const chatRes = await withTimeout(Runtime.evaluate({
                        expression: CHAT_EXTRACT_EXPR,
                        returnByValue: true
                    }), 5000, "Chat extract timeout");
                    await client.close();
                    
                    const chatText = chatRes.result?.value;
                    if (!chatText || chatText.trim().length < 30) continue;
                    
                    // Extract a unique snippet — use last agent response
                    const parts = chatText.split('🤖 Agent:');
                    let snippet = null;
                    if (parts.length > 1) {
                        const lastResponse = parts[parts.length - 1].trim();
                        // Take a 50-char snippet from the end
                        if (lastResponse.length > 50) {
                            snippet = lastResponse.substring(lastResponse.length - 50).trim();
                        } else {
                            snippet = lastResponse.trim();
                        }
                    }
                    
                    if (snippet && snippet.length > 15) {
                        // Search transcripts for this snippet
                        const appDataName = DriverFactory.getDriver().appDataName;
                        const brainPath = path.join(os.homedir(), '.gemini', appDataName, 'brain');
                        if (fs.existsSync(brainPath)) {
                            // Sort directories by mtime descending to check most recently active chats first
                            const dirs = fs.readdirSync(brainPath, { withFileTypes: true })
                                .filter(d => d.isDirectory())
                                .map(d => ({
                                    name: d.name,
                                    time: fs.statSync(path.join(brainPath, d.name)).mtime.getTime()
                                }))
                                .sort((a, b) => b.time - a.time);

                            for (const dir of dirs) {
                                const tp = path.join(brainPath, dir.name, '.system_generated', 'logs', 'transcript.jsonl');
                                if (!fs.existsSync(tp)) continue;
                                try {
                                    const stats = fs.statSync(tp);
                                    const readSize = Math.min(50000, stats.size);
                                    const fd = fs.openSync(tp, 'r');
                                    const buffer = Buffer.alloc(readSize);
                                    fs.readSync(fd, buffer, 0, readSize, Math.max(0, stats.size - readSize));
                                    fs.closeSync(fd);
                                    const tail = buffer.toString('utf8');
                                    if (tail.includes(snippet)) {
                                        lastResolvedThreadId = dir.name;
                                        _notifyThreadResolved(dir.name);
                                        threadNameToIdCache.set(threadName, dir.name);
                                        if (threadNameToIdCache.size > 500) { threadNameToIdCache.delete(threadNameToIdCache.keys().next().value); }
                                        console.log(`[snapshot] Anchored via DOM content match → ${dir.name}`);
                                        return;
                                    }
                                } catch (_) {}
                            }
                        }
                        console.log(`[snapshot] DOM content snippet "${snippet.substring(0, 30)}..." did not match any transcript`);
                    }
                } catch (e) {
                    // Try next candidate
                }
            }
        } catch (e) {
            console.log(`[snapshot] DOM content strategy failed: ${e.message}`);
        }
    }
    
    // Strategy 2: Use CDP to detect the active thread from IDE DOM
    try {
        const activeId = await getActiveThreadId(port, specificTargetId || preferredTargetId);
        if (!activeId) return;
        const appDataName = DriverFactory.getDriver().appDataName;
        const logsDir = path.join(os.homedir(), '.gemini', appDataName, 'brain', activeId, '.system_generated', 'logs');
        const hasLogs = fs.existsSync(path.join(logsDir, 'overview.txt')) || fs.existsSync(path.join(logsDir, 'transcript.jsonl'));
        if (!hasLogs) return;
        
        // Persist the resolved thread ID so /latest can use it directly
        // instead of re-guessing which window/thread is active
        lastResolvedThreadId = activeId;
        _notifyThreadResolved(activeId);
        console.log(`[snapshot] Anchored file-based thread: ${activeId}`);
        return;
    } catch (e) {
        console.log('[snapshot] File-based snapshot failed:', e.message);
    }
    
    // Strategy 3: DOM fallback for legacy behavior
    let candidates2 = await resolveTargets(port);
    if (specificTargetId) {
        candidates2 = candidates2.filter(t => t.id === specificTargetId);
    }
    for (const target of candidates2) {
        try {
            const client = await CDP({ target: target.webSocketDebuggerUrl });
            const { Runtime } = client;
            await Runtime.enable();
            const boxResult = await Runtime.evaluate({ expression: CHAT_EXTRACT_EXPR, awaitPromise: true, returnByValue: true });
            const val = boxResult?.result?.value;
            await client.close();
            if (val && val.length > 0) {
                console.log(`[snapshot] DOM fallback anchored (${val.length} chars)`);
                return;
            }
        } catch (_) {}
    }
}

/**
 * Get the latest agent response since the last snapshot.
 * 
 * Primary strategy: Read new entries from the active thread's overview.txt
 * since the last snapshotted step_index. This avoids stale DOM issues and
 * timestamp bleed from the DOM extraction.
 * 
 * Falls back to DOM extraction if the file doesn't exist.
 */

/**
 * Get the full last agent response block (no diffing).
 * Used by /latest command.
 * 
 * Strategy: Read from the file system instead of the DOM, because the IDE's
 * workspace DOM often retains stale content from previously-viewed threads.
 * 
 * 1. Get the active thread ID from the Manager sidebar (reliable)
 * 2. Read the thread's overview.txt log file from disk
 * 3. Parse the last user message + model response from the log
 * 4. Fall back to DOM extraction only if the file doesn't exist
 */
/**
 * Extract latest agent response from the DOM of the currently targeted window.
 * Used when a preferred window is set (so filesystem thread may differ) and
 * also called directly on window switch for auto-latest.
 */
async function _domLatestExtraction(port, specificTargetId = null) {
    let candidates = await resolveTargets(port);
    if (specificTargetId) {
        candidates = candidates.filter(t => t.id === specificTargetId);
    }
    for (const target of candidates) {
        try {
            const client = await CDP({ target: target.webSocketDebuggerUrl });
            const { Runtime } = client;
            await Runtime.enable();
            
            // Extract the whole chat history from the DOM
            const res = await Runtime.evaluate({
                expression: CHAT_EXTRACT_EXPR.replace('} catch(e) {}', '} catch(e) { extractedText = "ERROR_DOM: " + e.message; }'),
                returnByValue: true
            });
            await client.close();
            
            if (res.result?.value && res.result.value.trim() !== '') {
                const fullText = res.result.value.trim();
                if (fullText.startsWith('ERROR_DOM:')) {
                    console.debug('[_domLatestExtraction] DOM error:', fullText);
                    continue; // Try next candidate
                }
                
                // Try to find the last user message
                const parts = fullText.split('👤 User:');
                if (parts.length > 1) {
                    const lastTurn = parts[parts.length - 1];
                    const agentParts = lastTurn.split('🤖 Agent:');
                    if (agentParts.length > 1) {
                        return agentParts.slice(1).join('\\n\\n').trim();
                    }
                    return lastTurn.trim();
                }
                
                // If no User tag found, the fallback might have just returned all text.
                // We'll return the last 1500 chars to be safe, or just the whole thing
                // if it's small, because we don't want to return a huge wall of text.
                if (fullText.length > 3000) {
                    return fullText.substring(fullText.length - 3000);
                }
                return fullText;
            }
        } catch(e) {}
    }
    return null;
}

async function getInteractiveModalState(port, specificTargetId = null) {
    let candidates = await resolveTargets(port);
    if (specificTargetId) candidates = candidates.filter(t => t.id === specificTargetId);
    
    for (const target of candidates) {
        try {
            const client = await CDP({ target: target.webSocketDebuggerUrl });
            const { Runtime } = client;
            await Runtime.enable();
            const res = await Runtime.evaluate({
                expression: `(() => {

                    // Helper: check if element is truly visible on screen
                    // getBoundingClientRect is more reliable than offsetParent/computedStyle
                    // because IDE sometimes keeps dialogs in DOM with transform/clip tricks
                    const isVisible = (el) => {
                        if (!el) return false;
                        const r = el.getBoundingClientRect();
                        if (r.width === 0 || r.height === 0) return false;
                        if (r.bottom < 0 || r.top > window.innerHeight) return false;
                        if (r.right < 0 || r.left > window.innerWidth) return false;
                        const s = window.getComputedStyle(el);
                        return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0;
                    };
                    
                    // Find the first visible modal/dialog container, ignoring VSCode/Monaco editor widgets
                    const allContainers = Array.from(document.querySelectorAll('.modal, [role="dialog"], .interactive-session, [data-testid="interactive-modal"]')).filter(c => !c.classList.contains('editor-widget') && !c.closest('.monaco-editor'));
                    const visibleContainer = allContainers.find(c => isVisible(c));
                    const container = visibleContainer || document;
                    
                    // Only look for interactive elements if the container itself is visible
                    const isModal = container !== document
                        ? !!container.querySelector('textarea[placeholder*="Other" i], textarea[placeholder*="answer" i], input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], select')
                        : false;  // if no visible container found, assume no modal
                    
                    if (!isModal) return null;

                    
                    let headerEl = container.querySelector('.modal-header, [data-testid="interactive-modal"] h2, h3.font-medium, fieldset legend');
                    if (container !== document) {
                        headerEl = headerEl || container.querySelector('h2, h3, p.text-base, p.mb-4, p.text-sm');
                    } else {
                        headerEl = headerEl || document.querySelector('.chat-container h2, #conversation h2, .interactive-session h2, .interactive-session p');
                    }
                    let header = (headerEl && headerEl.textContent.trim());
                    
                    let options = [];
                    
                    if (isModal) {
                        const labels = Array.from(container.querySelectorAll('label'));
                        options = labels.map(l => (l.innerText || l.textContent).trim().replace(/^\\d+\\s*\\n?/, '')).filter(t => t && !t.match(/^(Other|Other \\(write your answer\\)|\\d+)$/i));
                        
                        if (options.length === 0) {
                            const items = Array.from(container.querySelectorAll('[role="radio"], [role="checkbox"]'));
                            options = items.map(el => (el.innerText || el.textContent).trim()).filter(Boolean);
                        }
                        
                        if (!header && options.length > 0) {
                            const firstLabel = container.querySelector('label, [role="radio"], [role="checkbox"]');
                            if (firstLabel) {
                                let walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, null);
                                let textNodesBeforeLabel = [];
                                let node;
                                while(node = walker.nextNode()) {
                                    if (node === firstLabel) break;
                                    if (node.contains(firstLabel)) continue;
                                    if (node.tagName === 'P' || node.tagName === 'H2' || node.tagName === 'H3' || node.tagName === 'H4') {
                                        textNodesBeforeLabel.push(node);
                                    }
                                }
                                for (let i = textNodesBeforeLabel.length - 1; i >= 0; i--) {
                                    const text = textNodesBeforeLabel[i].textContent.trim();
                                    if (text && text.length > 3) {
                                        header = text.split('\\n').pop().trim();
                                        break;
                                    }
                                }
                            }
                        }
                    } else if (hasApproval) {
                        const firstBtn = approvalBtns[0];
                        const textContainers = Array.from(container.querySelectorAll('p, h2, h3, h4, span, div')).filter(el => {
                            return el.offsetParent !== null && !el.contains(firstBtn) && (firstBtn.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING);
                        });
                        for (let i = textContainers.length - 1; i >= 0; i--) {
                            const text = textContainers[i].textContent.trim();
                            if (text && text.length > 5 && text.length < 150) {
                                header = text;
                                break;
                            }
                        }
                        options = approvalBtns.map(b => (b.textContent || '').trim());
                    }
                    
                    header = header || (hasApproval ? 'Agent Plan Review' : 'Agent Question');
                    
                    return { header, options, isApproval: hasApproval && !isModal };
                })()`,
                returnByValue: true
            });
            await client.close();
            
            if (res.result?.value) {
                return res.result.value;
            }
        } catch (e) {}
    }
    return null;
}

async function getFullLatestResponse(port, specificTargetId = null, threadName = null, includeThoughts = false) {
    const targetIdToUse = specificTargetId || preferredTargetId;
    
    let modalText = "";
    let modalButtons = null;
    try {
        const modalState = await getInteractiveModalState(port, targetIdToUse);
        if (modalState) {
            modalText = `\n\n⚠️ **${modalState.header}**\n`;
            if (modalState.options && modalState.options.length > 0) {
                modalText += `\n${t('interactive_modal.options_prompt')}`;
                modalButtons = {
                    reply_markup: {
                        inline_keyboard: modalState.options.map((opt, i) => ([{ text: `${i + 1}️⃣ ${opt}`, callback_data: `ans_${i + 1}` }]))
                    }
                };
            } else {
                modalText += `\n${t('interactive_modal.confirm_prompt')}`;
                modalButtons = {
                    reply_markup: {
                        inline_keyboard: [ [{ text: t('interactive_modal.btn_confirm') || 'Approve', callback_data: 'ans_Approve' }, { text: t('interactive_modal.btn_reject') || 'Reject', callback_data: 'ans_Reject' }] ]
                    }
                };
            }
        }
    } catch(e) {}
    
    
    // === PRIMARY: CDP DOM extraction (reads what's actually on screen) ===
    // This is the most reliable method for IDE because it reads the REAL active
    // conversation from the DOM, not a cached/stale threadId from the filesystem.
    // The filesystem approach was prone to returning responses from wrong conversations
    // when lastResolvedThreadId pointed to a stale thread.
    try {
        const domResult = await _domLatestExtraction(port, targetIdToUse);
        if (domResult && domResult.trim().length > 0) {
            console.log(`[getFullLatestResponse] ✓ DOM extraction successful (${domResult.length} chars) | Target: ${targetIdToUse || 'auto'}`);
            
            // Side-effect: resolve conversation UUID from the DOM content so that
            // /artifacts and other filesystem-dependent commands know which thread is active
            try {
                const snippet = domResult.length > 80 ? domResult.substring(20, 70).trim() : domResult.substring(0, 40).trim();
                if (snippet.length > 15) {
                    const appDataName = DriverFactory.getDriver().appDataName;
                    const brainPath = path.join(os.homedir(), '.gemini', appDataName, 'brain');
                    if (fs.existsSync(brainPath)) {
                        const dirs = fs.readdirSync(brainPath, { withFileTypes: true })
                            .filter(d => d.isDirectory());
                        for (const dir of dirs) {
                            const tp = path.join(brainPath, dir.name, '.system_generated', 'logs', 'transcript.jsonl');
                            if (!fs.existsSync(tp)) continue;
                            try {
                                const stats = fs.statSync(tp);
                                const readSize = Math.min(50000, stats.size);
                                const fd = fs.openSync(tp, 'r');
                                const buffer = Buffer.alloc(readSize);
                                fs.readSync(fd, buffer, 0, readSize, Math.max(0, stats.size - readSize));
                                fs.closeSync(fd);
                                if (buffer.toString('utf8').includes(snippet)) {
                                    lastResolvedThreadId = dir.name;
                                    _notifyThreadResolved(dir.name);
                                    console.log(`[getFullLatestResponse] Resolved thread from DOM content → ${dir.name.substring(0, 8)}`);
                                    break;
                                }
                            } catch (_) {}
                        }
                    }
                }
            } catch (_) {}
            
            return { text: domResult + modalText, buttons: modalButtons };
        }
    } catch (e) {
        console.log(`[getFullLatestResponse] DOM extraction failed: ${e.message}`);
    }

    // === FALLBACK: file-system extraction (reads pure markdown) ===
    // Used when DOM extraction fails or returns empty (e.g. page not loaded yet).
    // Relies on lastResolvedThreadId or getActiveThreadId to find the conversation.
    try {
        let activeId = lastResolvedThreadId;
        
        // If no cached thread, try to find one for the active workspace
        if (!activeId) {
            activeId = findConversationIdByTitle(threadName) || await getActiveThreadId(port, targetIdToUse);
        }

        if (activeId) {
            const appDataName = DriverFactory.getDriver().appDataName;
            const logsDir = path.join(os.homedir(), '.gemini', appDataName, 'brain', activeId, '.system_generated', 'logs');
            const transcriptPath = path.join(logsDir, 'transcript.jsonl');
            const overviewPath = path.join(logsDir, 'overview.txt');
            
            for (let attempt = 1; attempt <= 5; attempt++) {
                const logPath = fs.existsSync(transcriptPath) ? transcriptPath : (fs.existsSync(overviewPath) ? overviewPath : null);
                const isTranscript = logPath === transcriptPath;
                
                if (logPath) {
                    const content = fs.readFileSync(logPath, 'utf8');
                    const lines = content.split('\n').filter(l => l.trim());
                    let modelMsgs = [];
                    
                    for (let i = lines.length - 1; i >= 0; i--) {
                        try {
                            const entry = JSON.parse(lines[i]);
                            if (entry.source === 'USER_EXPLICIT' && entry.content) break;
                            if (entry.source === 'MODEL') {
                                if (isTranscript && entry.type !== 'PLANNER_RESPONSE') continue;
                                if (entry.content && entry.content.trim()) {
                                    let c = entry.content.trim();
                                    if (!includeThoughts) {
                                        c = c.replace(/<thought>[\s\S]*?<\/thought>\n?/g, '').trim();
                                    }
                                    if (c) modelMsgs.unshift(c);
                                }
                            }
                        } catch (_) {}
                    }
                    
                    if (modelMsgs.length > 0) {
                        console.log(`[getFullLatestResponse] ✓ Filesystem fallback successful: thread ${activeId.substring(0, 8)} (Attempt ${attempt})`);
                        return { text: modelMsgs.join('\n\n') + modalText, buttons: modalButtons };
                    }
                }
                
                if (attempt < 5) {
                    console.log(`[getFullLatestResponse] Filesystem returned empty messages, waiting 1s for flush... (Attempt ${attempt}/5)`);
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }
    } catch (e) {
        console.log('[getFullLatestResponse] Filesystem fallback failed:', e.message);
    }
    
    if (modalText) return { text: modalText.trim(), buttons: modalButtons };
    return { text: t('latest.not_found_active'), buttons: null };
}

async function captureAgentScreenshot(port) {
    const candidates = await resolveTargets(port);

    for (const target of candidates) {
        try {
            const client = await CDP({ target: target.webSocketDebuggerUrl });
            const { Page, Runtime } = client;
            await Page.enable();
            await Runtime.enable();

            const boxResult = await Runtime.evaluate({
                expression: `
                    (function() {
                        const selectors = [
                            '#conversation', '#chat', '#cascade', 
                            '.chat-container', '.messages-container', 
                            '[class*="message-list"]', '[class*="Conversation"]',
                            '.chat-input', '[contenteditable="true"]'
                        ];
                        let targetEl = null;
                        for (const s of selectors) {
                            targetEl = document.querySelector(s);
                            if (targetEl && targetEl.offsetParent !== null) {
                                if (s === '.chat-input' || s === '[contenteditable="true"]') {
                                     const container = targetEl.closest('#conversation, #chat, #cascade, [class*="Conversation"], [class*="chat-container"]');
                                     if (container) targetEl = container;
                                }
                                break;
                            }
                        }
                        if (!targetEl) targetEl = document.body;
                        if (targetEl.offsetHeight < 200) {
                            const scrollers = Array.from(document.querySelectorAll('div'))
                                .filter(d => d.offsetHeight > 400 && d.offsetParent !== null)
                                .sort((a, b) => b.offsetHeight - a.offsetHeight);
                            if (scrollers.length > 0) targetEl = scrollers[0];
                        }
                        const rect = targetEl.getBoundingClientRect();
                        return { x: rect.x, y: rect.y, width: rect.width || document.documentElement.clientWidth, height: rect.height || document.documentElement.clientHeight };
                    })()
                `,
                awaitPromise: true,
                returnByValue: true
            });

            const res = boxResult?.result?.value;
            if (res) {
                let screenshotResult = null;
                try {
                    screenshotResult = await Page.captureScreenshot({
                        format: 'jpeg',
                        quality: 85,
                        clip: {
                            x: Math.max(0, res.x || 0),
                            y: Math.max(0, res.y || 0),
                            width: Math.min(2500, Math.max(10, res.width || 800)),
                            height: Math.min(2500, Math.max(10, res.height || 600)),
                            scale: 1
                        }
                    });
                } catch(e) {
                    screenshotResult = await Page.captureScreenshot({ format: 'jpeg', quality: 70 });
                }
                await client.close();
                if (screenshotResult && screenshotResult.data) {
                    return Buffer.from(screenshotResult.data, 'base64');
                }
            }
        } catch(e) {}
    }
    throw new Error("Could not capture screenshot on any target");
}

async function waitForAgentResponse(port, timeoutMs = 450000, onProgress = null, specificTargetId = null) {
    const startTime = Date.now();
    let consecutiveIdleCount = 0;
    let spinnerOnlyCount = 0;
    let lastProgressTime = 0;
    const GRACE_PERIOD_MS = 6000; // Wait at least 6s before accepting idle — gives IDE time to start generating

    while (Date.now() - startTime < timeoutMs) {
        // Re-fetch targets on each iteration to avoid stale WebSocket connections
        let candidates;
        try {
            const raw = await resolveTargets(port);
            if (specificTargetId) {
                candidates = raw.filter(t => t.id === specificTargetId);
            } else {
                candidates = raw;
            }
        } catch(e) {
            await new Promise(r => setTimeout(r, 3000));
            continue;
        }

        let foundChat = false;
        let isIdle = false;
        let isGenerating = false;
        let lastEvalVal = null;

        for (const target of candidates) {
            try {
                const client = await CDP({ target: target.webSocketDebuggerUrl });
                const { Runtime } = client;
                await Runtime.enable();
                const check = await Runtime.evaluate({
                    expression: `
                        ${DriverFactory.getDriver().getLocatorsScript()}
                        (function() {
                            const container = document.querySelector('.antigravity-agent-side-panel, .modal, [role="dialog"], .interactive-session') || document;
                            const isModal = !!container.querySelector('textarea[placeholder*="Other" i], textarea[placeholder*="answer" i], input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], select, [data-testid="interactive-modal"]');
                            
                            const approvalBtns = Array.from(container.querySelectorAll('button')).filter(b => {
                                const t = (b.textContent || '').trim().toLowerCase();
                                return t === 'approve' || t === 'reject' || t === 'confirm' || t === 'allow' || t === 'proceed';
                            });
                            const isApproval = approvalBtns.length > 0;
                            
                            const isGenerating = !!AG_UI.getStopButton();
                            const editor = AG_UI.getChatInput();
                            const isInputDisabled = editor ? (editor.getAttribute('contenteditable') === 'false' || editor.disabled) : false;
                            const isSpinning = AG_UI.isLoading();
                            
                            // Check if AutoAccept is active and there is a button waiting to be clicked
                            const aaActive = !!window.__AA_BOT_OBSERVER_ACTIVE && !window.__AA_BOT_PAUSED;
                            let hasPendingButton = false;
                            if (aaActive) {
                                const texts = ${JSON.stringify(PENDING_ACTION_TEXTS)};
                                const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
                                hasPendingButton = btns.some(b => {
                                    const t = (b.textContent||'').trim().toLowerCase();
                                    return texts.some(x => t === x || t.startsWith(x + ' ') || (t.startsWith(x) && t.length <= x.length + 8));
                                });
                            }
                            
                            const isIdle = !isGenerating && (!isInputDisabled || isModal || isApproval) && !isSpinning && !hasPendingButton;
                            const hasChat = !!AG_UI.getVisibleChatContainer();
                            return { hasChat, isGenerating, isIdle, isSpinning, hasPendingButton, isModal };
                        })()
                    `,
                    returnByValue: true
                });
                const val = check?.result?.value;
                await client.close();

                if (val && val.hasChat) {
                    foundChat = true;
                    lastEvalVal = val; // Store for debug logging
                    if (val.isGenerating) isGenerating = true;
                    if (val.isIdle && !val.isGenerating) isIdle = true;
                    break;
                }
            } catch(e) { console.debug(`[waitForAgent] target ${target.title}: ${e.message}`); }
        }
        
        // Debug: log state every ~10 seconds (every 5th iteration since loop sleeps 2s)
        const loopElapsed = Date.now() - startTime;
        if (Math.floor(loopElapsed / 10000) !== Math.floor((loopElapsed - 2000) / 10000)) {
            const extra = lastEvalVal ? ` spin=${lastEvalVal.isSpinning} pendBtn=${lastEvalVal.hasPendingButton}` : '';
            console.log(`[waitForAgent] ${Math.round(loopElapsed/1000)}s | foundChat=${foundChat} idle=${isIdle} gen=${isGenerating} idleCount=${consecutiveIdleCount}${extra} | candidates=${candidates?.length || 0} target=${specificTargetId || 'auto'}`);
        }
        
        if (foundChat) {
            const elapsed = Date.now() - startTime;
            if (isIdle && !isGenerating) {
                // Only count idle after grace period — prevents false "done" before IDE starts
                if (elapsed > GRACE_PERIOD_MS) {
                    consecutiveIdleCount++;
                    if (consecutiveIdleCount >= 4) return true;
                }
            } else if (!isGenerating && lastEvalVal && lastEvalVal.isSpinning && !lastEvalVal.hasPendingButton) {
                // Spinner-only state: agent is not generating but IDE shows a spinner
                // This happens when agent sets a timer/schedule and is waiting
                // After enough consecutive checks, consider agent done
                if (elapsed > GRACE_PERIOD_MS) {
                    spinnerOnlyCount = (spinnerOnlyCount || 0) + 1;
                    if (spinnerOnlyCount >= 6) { // ~12 seconds of spinner-only
                        console.log(`[waitForAgent] Spinner-only idle detected after ${Math.round(elapsed/1000)}s — treating as done`);
                        return true;
                    }
                }
            } else {
                consecutiveIdleCount = 0;
                spinnerOnlyCount = 0;
            }
        }

        // Send typing action every 4 seconds to keep Telegram UI active
        const elapsed = Date.now() - startTime;
        if (onProgress && elapsed - lastProgressTime >= 4000) {
            lastProgressTime = elapsed;
            onProgress('typing');
        }

        await new Promise(r => setTimeout(r, 2000));
    }
    return false;
}

async function sendViaCDP(text, port, specificTargetId = null) {
    const candidates = await resolveTargets(port);
    let sortedCandidates = candidates;

    if (specificTargetId) {
        sortedCandidates = candidates.filter(t => t.id && t.id.startsWith(specificTargetId));
        if (sortedCandidates.length === 0) {
            console.log(`[sendViaCDP] specificTargetId ${specificTargetId} not found, falling back.`);
            specificTargetId = null;
        }
    }
    
    if (!specificTargetId) {
        if (preferredTargetId) {
            const pref = candidates.find(t => t.id === preferredTargetId);
            if (pref && pref.title) {
                const shortTitle = pref.title.substring(0, 15); // Match base workspace name
                sortedCandidates = candidates.filter(t => t.id === preferredTargetId || (t.title && t.title.includes(shortTitle)));
            } else {
                sortedCandidates = candidates.filter(t => t.id === preferredTargetId);
            }
        } else if (activeWorkspaceName) {
            const normalize = (s) => (s || '').toLowerCase().replace(/[-_]/g, ' ');
            const searchName = normalize(activeWorkspaceName);
            sortedCandidates = candidates.filter(t => normalize(t.title).includes(searchName));
            if (sortedCandidates.length === 0) sortedCandidates = candidates; // Fallback if none match
        }
    }

    const errors = [];
    for (const target of sortedCandidates) {
        let client;
        try {
            client = await withTimeout(CDP({ target: target.webSocketDebuggerUrl }), 3000, "CDP connect timeout");
            const { Runtime, Input } = client;
            await Runtime.enable();

            const slashCommand = getSelectableSlashCommandForTarget(text, target);
            const focusComposer = async () => {
                const res = await Runtime.evaluate({
                    expression: `
                        ${DriverFactory.getDriver().getLocatorsScript()}
                        (() => {
                            const editor = AG_UI.getChatInput();
                            if (!editor) return false;
                            editor.focus();
                            return true;
                        })()
                    `,
                    returnByValue: true
                });
                return !!res?.result?.value;
            };
            const nativeClearComposer = async () => {
                const isMac = process.platform === 'darwin';
                const modifier = isMac ? 4 : 2;
                const modifierKey = isMac ? 'Meta' : 'Control';
                const modifierCode = isMac ? 'MetaLeft' : 'ControlLeft';
                const modifierVk = isMac ? 91 : 17;
                await Input.dispatchKeyEvent({ type: 'keyDown', key: modifierKey, code: modifierCode, windowsVirtualKeyCode: modifierVk, nativeVirtualKeyCode: modifierVk, modifiers: modifier });
                await Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: modifier });
                await Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: modifier });
                await Input.dispatchKeyEvent({ type: 'keyUp', key: modifierKey, code: modifierCode, windowsVirtualKeyCode: modifierVk, nativeVirtualKeyCode: modifierVk, modifiers: 0 });
                await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
                await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
            };
            const nativeTypeComposer = async (value) => {
                await Input.insertText({ text: value || '' });
            };
            const preparedSlashCommand = slashCommand && await focusComposer().then(async focused => {
                if (!focused) return { slashPrefixTyped: false };
                await nativeClearComposer();
                await new Promise(r => setTimeout(r, 100));
                await nativeTypeComposer('/');
                return { slashPrefixTyped: true };
            }).catch(() => ({ slashPrefixTyped: false }));

            const focusResult = await withTimeout(Runtime.evaluate({
                expression: `
                    ${DriverFactory.getDriver().getLocatorsScript()}
                    (async function() {
                        try {
                            const escapedText = ${JSON.stringify(text)};
                            const slashCommand = ${JSON.stringify(slashCommand)};
                            const preparedSlashCommand = ${JSON.stringify(preparedSlashCommand)};
                            const rectOf = (el) => {
                                if (!el) return null;
                                const r = el.getBoundingClientRect();
                                return {
                                    x: r.x,
                                    y: r.y,
                                    width: r.width,
                                    height: r.height,
                                    centerX: r.x + r.width / 2,
                                    centerY: r.y + r.height / 2
                                };
                            };
                            
                            // Check if an interactive modal is active

                            // Important: getBoundingClientRect is more reliable — IDE may keep
                            // closed dialogs in DOM without display:none (uses transform/clip)
                            const allDialogs = Array.from(document.querySelectorAll('.modal, [role="dialog"], [data-testid="interactive-modal"]')).filter(c => !c.classList.contains('editor-widget') && !c.closest('.monaco-editor'));
                            const visibleDialog = allDialogs.find(d => {
                                const r = d.getBoundingClientRect();
                                if (r.width === 0 || r.height === 0) return false;
                                if (r.bottom < 0 || r.top > window.innerHeight) return false;
                                const style = window.getComputedStyle(d);
                                return style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0;
                            });
                            const container = visibleDialog || document;
                            const isActualModal = container !== document;
                            const approvalBtns = isActualModal ? Array.from(container.querySelectorAll('button')).filter(b => ['approve','reject','confirm','allow','proceed'].includes((b.textContent || '').trim().toLowerCase())) : [];
                            const optIndex = parseInt(escapedText) - 1;
                            const isValidIndex = !Number.isNaN(optIndex) && optIndex >= 0 && /^\d+$/.test(escapedText);
                            const radios = isActualModal ? Array.from(container.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]')) : [];
                            
                            const isModalActive = isActualModal || radios.length > 0;
                            const isConfirmAction = escapedText.toLowerCase() === 'onayla' || escapedText.toLowerCase() === 'confirm' || escapedText === 'ans_Approve';
                            const isRejectAction = escapedText.toLowerCase() === 'reddet' || escapedText.toLowerCase() === 'reject' || escapedText === 'ans_Reject';

                            
                            if (isModalActive && (isConfirmAction || isRejectAction)) {
                                if (isValidIndex && optIndex < approvalBtns.length) {
                                    approvalBtns[optIndex].click();
                                    return { found: true, method: 'approval-button-index', target: '${target.title?.substring(0, 30) || 'unknown'}' };
                                }
                                const matched = approvalBtns.find(b => (b.textContent || '').trim().toLowerCase() === escapedText.toLowerCase() || escapedText.toLowerCase() === 'ans_' + (b.textContent || '').trim().toLowerCase());
                                if (matched) {
                                    matched.click();
                                    return { found: true, method: 'approval-button-text', target: '${target.title?.substring(0, 30) || 'unknown'}' };
                                }
                                
                                const allBtns = Array.from(container.querySelectorAll('button'));
                                const btnTarget = isConfirmAction 
                                    ? (approvalBtns.find(b => (b.textContent||'').trim().toLowerCase() === 'approve') || allBtns.find(b => {
                                        const t = (b.textContent || '').trim().toLowerCase();
                                        return t === 'submit' || t.startsWith('submit') || t === 'gönder' || t === 'approve' || t === 'allow' || t === 'confirm';
                                      }))
                                    : (approvalBtns.find(b => (b.textContent||'').trim().toLowerCase() === 'reject') || allBtns.find(b => {
                                        const t = (b.textContent || '').trim().toLowerCase();
                                        return t === 'skip' || t === 'cancel' || t === 'iptal' || t === 'reject' || t === 'deny' || t === 'dismiss';
                                      }));
                                
                                if (btnTarget) {
                                    setTimeout(() => btnTarget.click(), 50);
                                    return { found: true, method: 'modal_button', target: '${target.title?.substring(0, 30) || 'unknown'}' };
                                }
                            }

                            if (radios.length > 0) {
                                // Check for radio/checkbox modal options by index
                                if (isValidIndex && optIndex < radios.length) {
                                    radios[optIndex].click();
                                    const allBtns = Array.from(container.querySelectorAll('button'));
                                    const sb = allBtns.find(b => {
                                        const t = (b.textContent || '').trim().toLowerCase();
                                        return t === 'submit' || t.startsWith('submit') || t === 'gönder' || t === 'approve' || t === 'allow' || t === 'proceed';
                                    });
                                    if (sb) setTimeout(() => sb.click(), 50);
                                    return { found: true, method: 'radio', target: '${target.title?.substring(0, 30) || 'unknown'}' };
                                }
                                
                                // Not a valid radio index. Does it have a write-in input?
                                const writeIn = container.querySelector('textarea:not([disabled]), input[type="text"]:not([disabled])');
                                if (writeIn && writeIn.offsetParent !== null) {
                                    writeIn.focus();
                                    const setter = Object.getOwnPropertyDescriptor(writeIn.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
                                    if (setter) setter.call(writeIn, escapedText);
                                    else writeIn.value = escapedText;
                                    
                                    writeIn.dispatchEvent(new Event('input', { bubbles: true }));
                                    writeIn.dispatchEvent(new Event('change', { bubbles: true }));
                                    
                                    const allBtns = Array.from(container.querySelectorAll('button'));
                                    const sb = allBtns.find(b => {
                                        const t = (b.textContent || '').trim().toLowerCase();
                                        return t === 'submit' || t.startsWith('submit') || t === 'gönder' || t === 'approve' || t === 'allow' || t === 'proceed';
                                    });
                                    if (sb) setTimeout(() => sb.click(), 50);
                                    return { found: true, method: 'write-in', target: '${target.title?.substring(0, 30) || 'unknown'}' };
                                }
                                
                                // No write-in input, and not a valid radio. DO NOT SUBMIT!
                                return { found: false, reason: "invalid_modal_option", method: "modal_rejected" };
                            }
                            // Use the robust centralized locator to find the actual chat input
                            const editor = AG_UI.getChatInput();
                            
                            if (!editor) return { found: false, reason: "no_editor", editorCount: 0 };

                            if (slashCommand) {
                                if (!preparedSlashCommand || !preparedSlashCommand.slashPrefixTyped) {
                                    return { found: false, reason: "slash_command_prefix_not_typed", command: slashCommand.command };
                                }
                                await new Promise(r => setTimeout(r, 400));
                                const optionCandidates = Array.from(document.querySelectorAll('button, [role="option"], [role="menuitem"], [cmdk-item], div[role="button"]'))
                                    .filter(el => el.offsetParent !== null);
                                const slashOption = optionCandidates.find(el => {
                                    const optionText = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
                                    return optionText === slashCommand.command || optionText.startsWith(slashCommand.command + ' ');
                                });
                                if (!slashOption) {
                                    return { found: false, reason: "slash_command_option_not_found", command: slashCommand.command };
                                }
                                return {
                                    found: true,
                                    method: 'slash_' + slashCommand.command,
                                    slashOptionRect: rectOf(slashOption),
                                    nativeTextAfterSelect: slashCommand.args,
                                    target: '${target.title?.substring(0, 30) || 'unknown'}'
                                };
                            }

                            editor.focus();
                            try {
                                document.execCommand("selectAll", false, null);
                                document.execCommand("delete", false, null);
                            } catch(e) {}

                            let inserted = false;
                            try { inserted = !!document.execCommand("insertText", false, escapedText); } catch(e) {}
                            
                            if (!inserted) {
                                if (editor.tagName === 'TEXTAREA') {
                                    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
                                    if (setter) setter.call(editor, escapedText);
                                    else editor.value = escapedText;
                                } else {
                                    editor.textContent = escapedText;
                                }
                                editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: escapedText }));
                                editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: escapedText }));
                                editor.dispatchEvent(new Event("change", { bubbles: true }));
                            }

                            // Use setTimeout instead of requestAnimationFrame so it doesn't hang when minimized!
                            await new Promise(r => setTimeout(r, 150));

                            // Dismiss any autocomplete/suggestion popups that may have appeared
                            // (e.g., when text starts with '/' the IDE opens a slash command popup)
                            editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', code: 'Escape', keyCode: 27 }));
                            editor.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Escape', code: 'Escape', keyCode: 27 }));
                            await new Promise(r => setTimeout(r, 100));

                            // Find the submit button near the editor (within same panel)
                            const panelContainer = editor.closest('#antigravity') || editor.closest('#conversation') || document;
                            // Primary: aria-label based search (most reliable in newer IDE)
                            const submitTexts = ${JSON.stringify(SUBMIT_ACTION_TEXTS)};
                            let submit = Array.from(panelContainer.querySelectorAll('button')).find(b => {
                                if (b.offsetParent === null) return false;
                                const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.textContent || '')).trim().toLowerCase();
                                return submitTexts.some(text => label === text || label.includes(text));
                            });
                            // Secondary: SVG icon search
                            if (!submit) {
                                submit = panelContainer.querySelector("svg.lucide-arrow-right, svg.lucide-arrow-up, svg[class*='arrow-right'], svg[class*='arrow-up'], svg[class*='send']")?.closest("button");
                            }
                            if (!submit) {
                                const allBtns = Array.from(panelContainer.querySelectorAll('button')).filter(b => b.offsetParent !== null);
                                submit = allBtns.find(b => {
                                    const text = (b.textContent || '').trim().toLowerCase();
                                    return submitTexts.some(action => text === action || text.startsWith(action + ' '));
                                });
                            }
                            
                            if (submit && !submit.disabled) {
                                setTimeout(() => submit.click(), 10);
                                return { found: true, method: 'button', target: '${target.title?.substring(0, 30) || 'unknown'}' };
                            }

                            setTimeout(() => {
                                ['keydown', 'keypress', 'keyup'].forEach(type => {
                                    editor.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }));
                                });
                            }, 10);
                            return { found: true, method: 'keyboard', target: '${target.title?.substring(0, 30) || 'unknown'}' };
                        } catch(err) {
                            return { found: false, reason: err.message };
                        }
                    })()
                `,
                awaitPromise: true,
                returnByValue: true
            }), 8000, "CDP evaluate timeout");
            const val = focusResult?.result?.value;
            console.log(`sendViaCDP [${target.title?.substring(0, 30)}]: result =`, JSON.stringify(val));
            
            if (val && val.found) {
                await new Promise(r => setTimeout(r, 50));
                try {
                    const dispatchNativeClick = async (rect) => {
                        if (!rect || !Number.isFinite(rect.centerX) || !Number.isFinite(rect.centerY)) return;
                        await Input.dispatchMouseEvent({ type: 'mouseMoved', x: rect.centerX, y: rect.centerY, button: 'none' });
                        await Input.dispatchMouseEvent({ type: 'mousePressed', x: rect.centerX, y: rect.centerY, button: 'left', clickCount: 1 });
                        await Input.dispatchMouseEvent({ type: 'mouseReleased', x: rect.centerX, y: rect.centerY, button: 'left', clickCount: 1 });
                    };

                    if (val.slashOptionRect) {
                        await dispatchNativeClick(val.slashOptionRect);
                        await new Promise(r => setTimeout(r, 500));
                    }

                    if (Object.prototype.hasOwnProperty.call(val, 'nativeTextAfterSelect')) {
                        await Input.insertText({ text: val.nativeTextAfterSelect || '' });
                        await new Promise(r => setTimeout(r, 200));
                    }

                    let isMac = process.platform === 'darwin';
                    try {
                        const versionInfo = await client.send('Browser.getVersion');
                        if (versionInfo && versionInfo.userAgent) {
                            isMac = versionInfo.userAgent.includes('Macintosh') || versionInfo.userAgent.includes('Mac OS X');
                        }
                    } catch (_) {}
                    const nativeEnter = isMac ? 36 : 13;

                    await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: nativeEnter, text: '\r' });
                    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: nativeEnter });
                } catch(e) {}
                await client.close();
                console.log(`sendViaCDP: Successfully sent via ${val.method} on "${target.title?.substring(0, 40)}"`);
                return target.id;
            } else if (val && val.reason === "invalid_modal_option") {
                await client.close();
                return "INVALID_MODAL_OPTION";
            }
            
            if (val) errors.push(`${target.title?.substring(0, 25)}: ${val.reason || 'no_editor'}`);
            await client.close();
        } catch(e) {
            if (e.message.includes('Promise was collected')) {
                console.log(`[sendViaCDP] Ignoring Promise was collected for ${target.title}, assuming success!`);
                try { if (client) await client.close(); } catch(_) {}
                return target.id;
            }
            errors.push(`${target.title?.substring(0, 25)}: ${e.message}`);
            try { if (client) await client.close(); } catch(_) {}
        }
    }
    console.log("sendViaCDP: Failed on all targets:", errors.join(' | '));
    throw new Error("no_chat_input");
}

async function triggerNewChat(port) {
    const candidates = await resolveTargets(port, false);
    const activeWsStr = activeWorkspaceName ? JSON.stringify(activeWorkspaceName.toLowerCase()) : 'null';

    for (const target of candidates) {
        try {
            const client = await CDP({ target: target.webSocketDebuggerUrl });
            const { Runtime } = client;
            await Runtime.enable();
            const res = await Runtime.evaluate({
                expression: `
                    ${DriverFactory.getDriver().getLocatorsScript()}
                    (() => {
                        const activeWs = ${activeWsStr};
                        if (activeWs) {
                            const cards = Array.from(document.querySelectorAll('[data-project-card="true"], [data-workspace-card="true"]'));
                            const targetCard = cards.find(card => {
                                const cloned = card.cloneNode(true);
                                cloned.querySelectorAll('svg').forEach(el => el.remove());
                                const wsNameRaw = cloned.textContent.trim();
                                const wsNameCleaned = wsNameRaw.replace(/\\s+\\d+$/, '').trim().toLowerCase();
                                return wsNameCleaned === activeWs || wsNameCleaned.includes(activeWs) || activeWs.includes(wsNameCleaned);
                            });
                            
                            if (targetCard) {
                                // Standalone Agent 2.0 new conversation link
                                const parent = targetCard.parentElement;
                                const newConvLink = parent ? parent.querySelector('a[aria-label*="New Conversation" i]') : null;
                                if (newConvLink && typeof newConvLink.click === 'function') {
                                    newConvLink.click();
                                    return { clicked: true, tag: newConvLink.tagName, type: 'workspace-specific-link' };
                                }

                                const plusIcon = targetCard.querySelector('button[aria-label*="New" i], svg.lucide-plus, svg.lucide-message-square-plus, svg[class*="plus"]') || 
                                                 targetCard.querySelector('path[d="M450-450H220v-60H450V-740h60v230H740v60H510v230H450V-450Z"]');
                                const plusBtn = plusIcon?.closest('button, [role="button"], a') || (plusIcon && plusIcon.parentElement);
                                
                                if (plusBtn && typeof plusBtn.click === 'function') {
                                    plusBtn.click();
                                    return { clicked: true, tag: plusBtn.tagName, type: 'workspace-specific' };
                                } else {
                                    // Fallback: targetCard might be a link or have its own click behavior 
                                    // if there's no explicitly separated + button but we expect workspace to activate
                                    const parent = targetCard.closest('[role="button"]') || targetCard.parentElement;
                                    if (parent) {
                                        const pPlusIcon = parent.querySelector('button[aria-label*="New" i], svg.lucide-plus, svg.lucide-message-square-plus, svg[class*="plus"]');
                                        const pPlusBtn = pPlusIcon?.closest('button, [role="button"], a') || pPlusIcon?.parentElement || pPlusIcon;
                                        if (pPlusBtn && typeof pPlusBtn.click === 'function') {
                                            pPlusBtn.click();
                                            return { clicked: true, tag: pPlusBtn.tagName, type: 'workspace-specific-parent' };
                                        }
                                    }
                                }
                            }
                        }

                        const btn = AG_UI.getNewChatButton();
                        if (btn && typeof btn.click === 'function') {
                            btn.click();
                            return { clicked: true, tag: btn.tagName, type: 'generic' };
                        }
                        return { clicked: false };
                    })()
                `, returnByValue: true
            });
            await client.close();
            const val = res.result?.value;
            if (val) {
                console.log('[triggerNewChat] Result:', JSON.stringify(val));
                if (val.clicked) return true;
            }
        } catch(e) {
            console.log('[triggerNewChat] Error on target:', e.message);
        }
    }
    return false;
}



async function triggerModelMenu(port) {
    const raw = await resolveTargets(port, false);
    // Manager has the active conversation's model selector
    const candidates = raw;

    for (const target of candidates) {
        try {
            const client = await CDP({ target: target.webSocketDebuggerUrl });
            const { Runtime } = client;
            await Runtime.enable();
            const res = await Runtime.evaluate({
                expression: `
                    ${DriverFactory.getDriver().getLocatorsScript()}
                    (() => {
                        const btn = AG_UI.getModelSelectorButton();
                        if (btn) {
                            const ariaControls = btn.getAttribute('aria-controls');
                            const popoverEl = ariaControls ? document.getElementById(ariaControls) : null;
                            const isExpanded = btn.getAttribute('aria-expanded') === 'true' || (popoverEl && AG_UI.isVisible(popoverEl));
                            if (!isExpanded) {
                                const opts = { bubbles: true, cancelable: true, view: window };
                                btn.dispatchEvent(new MouseEvent('pointerdown', opts));
                                btn.dispatchEvent(new MouseEvent('mousedown', opts));
                                btn.dispatchEvent(new MouseEvent('pointerup', opts));
                                btn.dispatchEvent(new MouseEvent('mouseup', opts));
                                btn.dispatchEvent(new MouseEvent('click', opts));
                            }
                            return true;
                        }
                        return false;
                    })()
                `, returnByValue: true
            });
            await client.close();
            if (res.result?.value) return true;
        } catch(e) {}
    }
    return false;
}

async function listAgentThreads(port) {
    const candidates = await resolveTargets(port, false);
    const normalize = (s) => (s || '').toLowerCase().replace(/[-_]/g, ' ');
    const allWorkspaces = [];
    const driver = DriverFactory.getDriver();
    
    let popupCollected = false;

    for (const target of candidates) {
        try {
            const client = await CDP({ target: target.webSocketDebuggerUrl });
            const { Runtime } = client;
            await Runtime.enable();
            
            if (driver.appType === 'ide') {
                if (!popupCollected) {
                    const openRes = await Runtime.evaluate({
                        expression: `(() => {
                            const existing = document.querySelector('input[placeholder*="Search all"], input[placeholder="Select a conversation"], input[placeholder*="convo"]');
                            if (existing) return "already-open";
                            const icon = document.querySelector("svg.lucide-history");
                            if (!icon) return "no-icon";
                            (icon.closest("button") || icon.parentElement).click();
                            return "opened";
                        })()`
                    });
                    
                    if (openRes.result?.value !== 'no-icon') {
                        await new Promise(r => setTimeout(r, openRes.result?.value === 'opened' ? 800 : 200));
                        
                        // Expand all "show more" buttons (e.g. fastpick-show-more-Recent, fastpick-show-more-Running)
                        await Runtime.evaluate({
                            expression: `(() => {
                                const showMoreEls = Array.from(document.querySelectorAll('[id^="fastpick-show-more-"], [id*="show-more"]'));
                                if (showMoreEls.length === 0) {
                                    const textMatches = Array.from(document.querySelectorAll('div')).filter(d => /^show\\s+\\d+\\s+more/i.test(d.textContent.trim()));
                                    textMatches.forEach(el => el.click());
                                } else {
                                    showMoreEls.forEach(el => el.click());
                                }
                            })()`
                        });
                        await new Promise(r => setTimeout(r, 600));

                        const popupRes = await Runtime.evaluate({
                            expression: driver.getListAgentThreadsScript(),
                            returnByValue: true
                        });
                        
                        // Close popup
                        await Runtime.evaluate({
                            expression: `(() => {
                                document.body.click();
                                const esc = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true });
                                document.activeElement.dispatchEvent(esc);
                                document.dispatchEvent(esc);
                            })()`
                        });
                        
                        const popupWorkspaces = JSON.parse(popupRes.result?.value || '[]');
                        for (const pw of popupWorkspaces) {
                            const existing = allWorkspaces.find(w => normalize(w.workspace) === normalize(pw.workspace));
                            if (existing) {
                                for (const t of pw.threads) {
                                    if (!existing.threads.some(et => et.name === t.name)) existing.threads.push(t);
                                }
                            } else {
                                allWorkspaces.push(pw);
                            }
                        }
                        popupCollected = true;
                    }
                }
            } else {
                // Standalone 2.0 extraction
                const homeRes = await Runtime.evaluate({
                    expression: driver.getListAgentThreadsScript(),
                    returnByValue: true
                });
                
                const homeWorkspaces = JSON.parse(homeRes.result?.value || '[]');
                for (const hw of homeWorkspaces) {
                    const existing = allWorkspaces.find(w => normalize(w.workspace) === normalize(hw.workspace));
                    if (existing) {
                        for (const t of hw.threads) {
                            if (!existing.threads.some(et => et.name === t.name)) existing.threads.push(t);
                        }
                    } else {
                        allWorkspaces.push(hw);
                    }
                }
                
                if (homeWorkspaces.length > 0) {
                    // Standalone targets usually have all threads on a single target if it's the home screen
                    popupCollected = true; 
                }
            }
            
            await client.close();
            
            if (popupCollected && driver.appType !== 'ide') {
                break;
            }
        } catch(e) { console.debug(`[listAgentThreads] window error: ${e.message}`); }
    }
    
    return allWorkspaces;
}

function setActiveWorkspace(name) {
    activeWorkspaceName = name ? name.toLowerCase() : null;
    lastResolvedThreadId = null;
    preferredTargetId = null;
}

async function switchAgentThread(port, threadName, targetWorkspaceName = null) {
    const candidates = await resolveTargets(port, false);
    for (const target of candidates) {
        try {
            const client = await CDP({ target: target.webSocketDebuggerUrl });
            const { Runtime } = client;
            await Runtime.enable();
            
            const driver = DriverFactory.getDriver();
            const threadNameStr = JSON.stringify(threadName);
            const targetWsNameStr = targetWorkspaceName ? JSON.stringify(targetWorkspaceName.toLowerCase()) : 'null';
            
            if (driver.appType === 'agent') {
                const clickRes = await Runtime.evaluate({
                    expression: driver.getSwitchThreadScript(threadNameStr, targetWsNameStr),
                    awaitPromise: true,
                    returnByValue: true
                });
                
                await client.close();
                
                if (clickRes.result?.value === 'clicked') {
                    console.log(`[switchAgentThread] Clicked standalone thread "${threadName}", waiting 2500ms...`);
                    await new Promise(r => setTimeout(r, 2500));
                    
                    // Read the new URL from the page to extract conversation ID directly
                    try {
                        const client2 = await CDP({ target: target.webSocketDebuggerUrl });
                        const { Runtime: Runtime2 } = client2;
                        await Runtime2.enable();
                        const urlRes = await Runtime2.evaluate({
                            expression: `window.location.href`,
                            returnByValue: true
                        });
                        await client2.close();
                        
                        const href = urlRes.result?.value || '';
                        const uuidMatch = href.match(/\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
                        if (uuidMatch) {
                            const conversationId = uuidMatch[1];
                            console.log(`[switchAgentThread] Extracted conversation ID from URL: ${conversationId}`);
                            lastResolvedThreadId = conversationId;
                            _notifyThreadResolved(conversationId);
                            threadNameToIdCache.set(threadName, conversationId);
                        }
                    } catch (urlErr) {
                        console.log(`[switchAgentThread] Could not read URL after click: ${urlErr.message}`);
                    }
                    
                    return target.id;
                } else if (clickRes.result?.value === 'already-active') {
                    console.log(`[switchAgentThread] Thread "${threadName}" is already active.`);
                    return target.id;
                }
                console.log(`[switchAgentThread] Standalone thread "${threadName}" not found. Result: ${clickRes.result?.value}`);
                continue;
            }
            
            // Fallback for Classic IDE:
            const openRes = await Runtime.evaluate({
                expression: driver.getSwitchThreadScript()
            });
            if (openRes.result?.value === 'no-icon') { await client.close(); continue; }
            await new Promise(r => setTimeout(r, openRes.result?.value === 'opened' ? 800 : 200));
            
            // Filter the quickpick list by typing the thread name to handle virtualization
            await Runtime.evaluate({
                expression: `(() => {
                    const input = document.querySelector('input[placeholder*="Search all"], input[placeholder="Select a conversation"], input[placeholder*="convo"]');
                    if (input) {
                        input.focus();
                        input.value = '';
                        try { document.execCommand("insertText", false, ${threadNameStr}); } catch(e) {}
                        if (!input.value) {
                            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                            if (setter) setter.call(input, ${threadNameStr});
                            else input.value = ${threadNameStr};
                        }
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                })()`
            });
            
            await new Promise(r => setTimeout(r, 600)); // Wait for filtering animation
            
            const res = await Runtime.evaluate({
                expression: driver.getSwitchThreadQuickpickScript(threadNameStr),
                awaitPromise: true,
                returnByValue: true
            });
            await client.close();
            if (res.result?.value) {
                // Step 4: Handle "Select where to open the conversation" popup
                // When selecting a thread from a different workspace, the IDE shows
                // a quickpick asking where to open it. We prefer "Open in workspace".
                await new Promise(r => setTimeout(r, 500));
                let didClickWorkspace = false;
                try {
                    const client2 = await CDP({ target: target.webSocketDebuggerUrl });
                    const { Runtime: Runtime2 } = client2;
                    await Runtime2.enable();
                    const qRes = await Runtime2.evaluate({
                        expression: `(() => {
                            const items = Array.from(document.querySelectorAll('[role="option"], .quick-input-list-entry, .monaco-list-row'));
                            const wsOption = items.find(el => {
                                const text = (el.textContent || '').toLowerCase();
                                return text.includes('open in workspace') || text.includes('workspace:');
                            });
                            const currentOption = items.find(el => {
                                const text = (el.textContent || '').toLowerCase();
                                return text.includes('open in current window') || text.includes('current window');
                            });
                            
                            const targetOption = wsOption || currentOption;
                            if (targetOption) {
                                targetOption.scrollIntoView();
                                targetOption.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                                targetOption.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                                targetOption.click();
                                return targetOption === wsOption ? 'workspace' : 'current';
                            }
                            return null;
                        })()`,
                        returnByValue: true
                    });
                    didClickWorkspace = qRes.result?.value === 'workspace';
                    await client2.close();
                } catch(_) { /* popup may not appear for same-workspace threads */ }
                
                let finalTargetId = target.id;
                let finalWsUrl = target.webSocketDebuggerUrl;

                if (didClickWorkspace && targetWorkspaceName) {
                    console.log(`[switchAgentThread] Clicked 'Open in workspace'. Waiting for new window for: ${targetWorkspaceName}`);
                    const normalize = (s) => (s || '').toLowerCase().replace(/[-_]/g, ' ');
                    const searchName = normalize(targetWorkspaceName);
                    
                    let foundNewTarget = null;
                    for (let i = 0; i < 15; i++) {
                        await new Promise(r => setTimeout(r, 1000));
                        try {
                            // Fetch raw targets without activeWorkspaceName filter bias
                            const raw = await httpGet(`http://127.0.0.1:${port}/json`);
                            const targets = JSON.parse(raw);
                            foundNewTarget = targets.find(t => 
                                (t.type === 'page' || t.type === 'webview') &&
                                t.webSocketDebuggerUrl &&
                                !t.url.includes('devtools://') &&
                                normalize(t.title).includes(searchName)
                            );
                            if (foundNewTarget) break;
                        } catch(e) {}
                    }
                    if (foundNewTarget) {
                        console.log(`[switchAgentThread] Found new window target: ${foundNewTarget.id}`);
                        finalTargetId = foundNewTarget.id;
                        finalWsUrl = foundNewTarget.webSocketDebuggerUrl;
                    }
                }

                // Step 5: Wait for the new thread's chat input to become ready.
                // Without this, the first message after switching gets lost because
                // the editor hasn't loaded yet.
                for (let waitAttempt = 0; waitAttempt < 10; waitAttempt++) {
                    await new Promise(r => setTimeout(r, 500));
                    try {
                        const client3 = await CDP({ target: finalWsUrl });
                        const { Runtime: Runtime3 } = client3;
                        await Runtime3.enable();
                        const readyCheck = await Runtime3.evaluate({
                            expression: `(() => {
                                const editors = [...document.querySelectorAll('[contenteditable="true"]')]
                                    .filter(el => !el.className.includes('xterm') && el.offsetParent !== null);
                                return editors.length > 0;
                            })()`,
                            returnByValue: true
                        });
                        await client3.close();
                        if (readyCheck.result?.value) {
                            console.log(`[switchAgentThread] Chat input ready after ${(waitAttempt + 1) * 500}ms`);
                            break;
                        }
                    } catch(_) {}
                }
                
                return finalTargetId;
            }
        } catch(e) { console.debug(`[switchAgentThread] error: ${e.message}`); }
    }
    return null;
}

async function getActiveThreadInfo(port, specificTargetId = null) {
    let threadId = null;
    let threadName = null;
    let workspaceName = null;

    let candidates = await resolveTargets(port, false);
    if (specificTargetId) {
        candidates = candidates.filter(t => t.id === specificTargetId);
    }
    // 1. Try to get Name, Workspace, and Thread ID from the DOM
    for (const target of candidates) {
        try {
            const client = await withTimeout(CDP({ target: target.webSocketDebuggerUrl }), 2000, "CDP timeout");
            const { Runtime } = client;
            await Runtime.enable();
            const driver = DriverFactory.getDriver();
            const res = await withTimeout(Runtime.evaluate({
                expression: driver.getActiveThreadInfoScript(),
                returnByValue: true
            }), 3000, "Evaluate timeout");
            await client.close();
            if (res.result?.value) {
                if (res.result.value.name && !threadName) threadName = res.result.value.name;
                if (res.result.value.threadId && !threadId) threadId = res.result.value.threadId;
                
                let wsName = res.result.value.workspace;
                if (wsName && wsName.includes(' - ')) wsName = wsName.split(' - ')[0].trim();
                if (wsName && wsName !== 'undefined' && wsName !== 'Launchpad') {
                    if (!workspaceName) workspaceName = wsName;
                }
                
                // Only break if we got a REAL thread name (not just workspace/title fallback)
                // If threadId was found directly from DOM, that's authoritative — break immediately
                if (threadId) break;
                if (threadName && res.result.value.nameSource !== 'document-title') break;
            }
        } catch(e) { console.debug(`[getActiveThreadInfo] target error: ${e.message}`); }
    }

    if (!threadId && threadName) {
        threadId = findConversationIdByTitle(threadName);
    }

    // 2. Fallback: Get Thread ID via file-system logs of the app
    // New IDE uses transcript.jsonl, legacy used overview.txt — check both
    // If activeWorkspaceName is set or specificTargetId provides a workspace, filter by it.
    if (!threadId) {
        try {
            const appDataName = DriverFactory.getDriver().appDataName;
            const brainPath = path.join(os.homedir(), '.gemini', appDataName, 'brain');
            if (fs.existsSync(brainPath)) {
                const dirs = fs.readdirSync(brainPath, { withFileTypes: true });
                let latestTime = 0;
                
                let filterWorkspace = null;
                if (specificTargetId) {
                    const c = candidates.find(t => t.id === specificTargetId);
                    if (c && c.title) filterWorkspace = c.title.split(' - ')[0].trim();
                } else if (activeWorkspaceName) {
                    filterWorkspace = activeWorkspaceName;
                }
                
                for (const dir of dirs) {
                    if (!dir.isDirectory()) continue;
                    const logsDir = path.join(brainPath, dir.name, '.system_generated', 'logs');
                    const transcriptPath = path.join(logsDir, 'transcript.jsonl');
                    const overviewPath = path.join(logsDir, 'overview.txt');
                    
                    let bestMtime = 0;
                    try { if (fs.existsSync(transcriptPath)) bestMtime = Math.max(bestMtime, fs.statSync(transcriptPath).mtimeMs); } catch (_) {}
                    try { if (fs.existsSync(overviewPath)) bestMtime = Math.max(bestMtime, fs.statSync(overviewPath).mtimeMs); } catch (_) {}
                    
                    if (bestMtime > latestTime) {
                        // Apply workspace filtering if required
                        let match = true;
                        if (filterWorkspace) {
                            match = false;
                            const logPath = fs.existsSync(transcriptPath) ? transcriptPath : (fs.existsSync(overviewPath) ? overviewPath : null);
                            if (logPath) {
                                try {
                                    const stats = fs.statSync(logPath);
                                    const head = fs.readFileSync(logPath, 'utf8').substring(0, 8000);
                                    const normalize = (s) => (s || '').toLowerCase().replace(/[-_]/g, ' ');
                                    const workspaceNameNormalized = normalize(filterWorkspace);
                                    
                                    let foundInUserInfo = false;
                                    const userInfoMatch = head.match(/<user_information>([\s\S]*?)<\/user_information>/);
                                    if (userInfoMatch) {
                                        const userInfo = userInfoMatch[1];
                                        // Match format: /path/to/workspace -> workspaceName
                                        foundInUserInfo = userInfo.includes(`/${filterWorkspace} ->`) || 
                                                          userInfo.includes(`\\\\${filterWorkspace} ->`) ||
                                                          userInfo.includes(`/${filterWorkspace}`) ||
                                                          userInfo.includes(`-> ${filterWorkspace}`);
                                    }

                                    if (foundInUserInfo) {
                                        match = true;
                                    } else {
                                        // Allow extremely recent new threads (modified within last 90 seconds, size under 8KB)
                                        // since new threads won't contain workspace path references yet in their first user step.
                                        const ageMs = Date.now() - stats.mtimeMs;
                                        if (ageMs < 90000 && stats.size < 8000) {
                                            match = true;
                                        }
                                    }
                                } catch (_) {}
                            }
                        }
                        
                        if (match) {
                            latestTime = bestMtime;
                            threadId = dir.name;
                        }
                    }
                }
            }
        } catch(e) { console.debug(`[getActiveThreadInfo] fallback error: ${e.message}`); }
    }

    if (!workspaceName && activeWorkspaceName) {
        workspaceName = activeWorkspaceName;
    }

    if (threadId || workspaceName) {
        return { id: threadId, name: threadName, workspace: workspaceName };
    }
    return null;
}

async function getActiveThreadId(port, specificTargetId = null) {
    const info = await getActiveThreadInfo(port, specificTargetId);
    return info ? info.id : null;
}
async function isAgentWorking(port, specificTargetId = null) {
    let candidates = await resolveTargets(port, false);
    if (specificTargetId) {
        candidates = candidates.filter(t => t.id === specificTargetId);
    }
    for (const target of candidates) {
        try {
            const client = await withTimeout(CDP({ target: target.webSocketDebuggerUrl }), 2000, "CDP timeout");
            const { Runtime } = client;
            await Runtime.enable();
            const check = await withTimeout(Runtime.evaluate({
                expression: `
                    ${DriverFactory.getDriver().getLocatorsScript()}
                    (function() {
                        const container = document.querySelector('.antigravity-agent-side-panel, .modal, [role="dialog"], .interactive-session') || document;
                        const isModal = !!container.querySelector('textarea[placeholder*="Other" i], textarea[placeholder*="answer" i], input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], select, [data-testid="interactive-modal"]');

                        const isGenerating = !!AG_UI.getStopButton();
                        const editor = AG_UI.getChatInput();
                        const isInputDisabled = editor ? (editor.getAttribute('contenteditable') === 'false' || editor.disabled) : false;
                        const isSpinning = AG_UI.isLoading();
                        
                        const aaActive = !!window.__AA_BOT_OBSERVER_ACTIVE && !window.__AA_BOT_PAUSED;
                        let hasPendingButton = false;
                        if (aaActive) {
                            const texts = ['run', 'accept', 'allow', 'continue', 'retry', 'çalıştır', 'kabul et', 'izin ver', 'devam et', 'yeniden dene'];
                            const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
                            hasPendingButton = btns.some(b => {
                                const t = (b.textContent||'').trim().toLowerCase();
                                return texts.some(x => t === x || t.startsWith(x + ' ') || (t.startsWith(x) && t.length <= x.length + 8));
                            });
                        }
                        
                        return isGenerating || (!isModal && isInputDisabled) || isSpinning || hasPendingButton;
                    })()
                `,
                returnByValue: true
            }), 3000, "Evaluate timeout");
            await client.close();
            if (check && check.result && check.result.value !== undefined) {
                return check.result.value;
            }
        } catch(e) { console.debug(`[isAgentWorking] target error: ${e.message}`); }
    }
    return false;
}

async function getCurrentModel(port) {
    const candidates = await resolveTargets(port, false);
    for (const target of candidates) {
        try {
            const client = await CDP({ target: target.webSocketDebuggerUrl });
            const { Runtime } = client;
            await Runtime.enable();
            const check = await Runtime.evaluate({
                expression: `
                    ${DriverFactory.getDriver().getLocatorsScript()}
                    (function() {
                        const btn = AG_UI.getModelSelectorButton();
                        if (btn) {
                            const label = btn.getAttribute('aria-label') || '';
                            const current = label.match(/(?:current|当前)[：:]\\s*(.+)$/i);
                            if (current && current[1]) return current[1].trim();
                            return btn.textContent.trim();
                        }
                        return null;
                    })()
                `, returnByValue: true
            });
            await client.close();
            if (check?.result?.value) return check.result.value;
        } catch(e) {}
    }
    return null;
}

async function switchStandaloneWorkspace(port, wsName) {
    if (!wsName) return false;
    const cleanWsName = wsName.trim().toLowerCase();
    const candidates = await resolveTargets(port, false);
    for (const target of candidates) {
        try {
            const client = await CDP({ target: target.webSocketDebuggerUrl });
            const { Runtime } = client;
            await Runtime.enable();
            
            // First check if Standalone Agent 2.0 UI is active (presence of project cards in DOM)
            const isStandaloneRes = await Runtime.evaluate({
                expression: `(() => {
                    return !!(document.querySelector('[data-project-card="true"]') ||
                              document.querySelector('[data-workspace-card="true"]') ||
                              document.querySelector('[data-project-card]') ||
                              document.querySelector('[data-workspace-card]'));
                })()`,
                returnByValue: true
            });
            
            if (isStandaloneRes.result?.value) {
                const cleanWsNameStr = JSON.stringify(cleanWsName);
                const clickRes = await Runtime.evaluate({
                    expression: `(() => {
                        const cards = Array.from(document.querySelectorAll('[data-project-card="true"], [data-workspace-card="true"], [data-project-card], [data-workspace-card]'));
                        const cleanWsName = ${cleanWsNameStr};
                        
                        const targetCard = cards.find(card => {
                            const cloned = card.cloneNode(true);
                            cloned.querySelectorAll('svg').forEach(el => el.remove());
                            const wsNameRaw = cloned.textContent.trim();
                            // Clean trailing numbers like "alana.com.tr 3" -> "alana.com.tr"
                            const wsNameCleaned = wsNameRaw.replace(/\\s+\\d+$/, '').trim().toLowerCase();
                            
                            return wsNameCleaned === cleanWsName || wsNameCleaned.includes(cleanWsName) || cleanWsName.includes(wsNameCleaned);
                        });
                        
                        if (targetCard) {
                            // Only click if collapsed to expand it; don't toggle-close an already open card
                            if (targetCard.getAttribute('aria-expanded') !== 'true') {
                                targetCard.click();
                            }
                            return true;
                        }
                        return false;
                    })()`,
                    returnByValue: true
                });
                
                await client.close();
                if (clickRes.result?.value) {
                    console.log(`[switchStandaloneWorkspace] Successfully clicked workspace card for: ${wsName}`);
                    return true;
                }
            } else {
                await client.close();
            }
        } catch (e) {
            console.debug(`[switchStandaloneWorkspace] Error focusing workspace ${wsName}: ${e.message}`);
        }
    }
    return false;
}

/**
 * Click an artifact feedback button (Proceed/Cancel) in the IDE via CDP.
 * Searches for buttons in the chat panel that match the given label text.
 * 
 * @param {string} buttonLabel - The button text to find (e.g., 'Proceed', 'Cancel')
 * @param {number} port - CDP debugging port
 * @param {string|null} specificTargetId - Optional specific target window
 * @returns {Promise<boolean>} true if the button was found and clicked
 */
async function clickArtifactButton(buttonLabel, port, specificTargetId = null) {
    const candidates = await resolveTargets(port);
    let targets = candidates;

    if (specificTargetId) {
        targets = candidates.filter(t => t.id && t.id.startsWith(specificTargetId));
    } else if (preferredTargetId) {
        targets = candidates.filter(t => t.id === preferredTargetId);
        if (targets.length === 0) targets = candidates;
    }

    const labelLower = buttonLabel.toLowerCase();

    for (const target of targets) {
        let client;
        try {
            client = await withTimeout(CDP({ target: target.webSocketDebuggerUrl }), 3000, "CDP connect timeout");
            const { Runtime } = client;
            await Runtime.enable();

            const result = await withTimeout(Runtime.evaluate({
                expression: `
                    (function() {
                        // Search for the artifact feedback button by its text content
                        var label = ${JSON.stringify(labelLower)};
                        var allButtons = Array.from(document.querySelectorAll('button'));
                        
                        // Also search inside shadow roots
                        document.querySelectorAll('*').forEach(function(el) {
                            if (el.shadowRoot) {
                                allButtons.push.apply(allButtons, Array.from(el.shadowRoot.querySelectorAll('button')));
                            }
                        });
                        
                        // Find buttons matching the label
                        var candidates = allButtons.filter(function(btn) {
                            var text = (btn.textContent || '').trim().toLowerCase();
                            return text === label || text.startsWith(label);
                        });
                        
                        if (candidates.length === 0) {
                            return { found: false, error: 'No button found with text: ' + label };
                        }
                        
                        // Prefer the LAST matching button (most recent artifact)
                        var btn = candidates[candidates.length - 1];
                        
                        // Check if button is actually clickable
                        if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
                            return { found: true, clicked: false, error: 'Button is disabled' };
                        }
                        
                        btn.click();
                        try {
                            btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                            btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                        } catch(e) {}
                        
                        return { found: true, clicked: true, text: btn.textContent.trim() };
                    })()
                `,
                returnByValue: true
            }), 8000, "clickArtifactButton timeout");

            await client.close();

            const val = result?.result?.value;
            if (val && val.clicked) {
                console.log(`[clickArtifactButton] Clicked "${val.text}" in target ${target.id.substring(0, 8)}`);
                return true;
            }
            if (val && val.found && !val.clicked) {
                console.log(`[clickArtifactButton] Button found but not clickable: ${val.error}`);
            }
        } catch (e) {
            try { if (client) await client.close(); } catch (_) {}
            console.log(`[clickArtifactButton] Error in target ${target.id?.substring(0, 8)}: ${e.message}`);
        }
    }

    throw new Error(`Could not find or click "${buttonLabel}" button in any IDE target`);
}

module.exports = {
    PENDING_ACTION_TEXTS,
    SUBMIT_ACTION_TEXTS,
    getSelectableSlashCommandForTarget,
    findConversationIdByTitle,
    isAgentWorking,
    getFullLatestResponse,
    snapshotChatState,
    captureAgentScreenshot,
    captureFullIDEScreenshot,
    waitForAgentResponse,
    sendViaCDP,
    clickArtifactButton,
    triggerNewChat,
    triggerModelMenu,
    getAvailableModels,
    selectModel,
    getCurrentModel,
    stopAgent,
    getQuota,
    resolveTargets,
    listWindows,
    setPreferredWindow,
    getPreferredWindow,
    getPreferredTargetId,
    getCachedWindows,
    closeWindow,
    closeAllEditors,
    listAgentThreads,
    switchAgentThread,
    CHAT_EXTRACT_EXPR,
    getActiveThreadId,
    getActiveThreadInfo,
    setActiveWorkspace,
    switchStandaloneWorkspace,
    getLastResolvedThreadId, setLastResolvedThreadId,
    setOnThreadResolved
};

async function captureFullIDEScreenshot(port) {
    const candidates = await resolveTargets(port);

    for (const target of candidates) {
        try {
            const client = await CDP({ target: target.webSocketDebuggerUrl });
            const { Page } = client;
            await Page.enable();

            const screenshotResult = await Page.captureScreenshot({
                format: 'jpeg',
                quality: 80
            });
            await client.close();
            if (screenshotResult && screenshotResult.data) {
                return Buffer.from(screenshotResult.data, 'base64');
            }
        } catch(e) {}
    }
    throw new Error("Could not capture full screenshot via CDP");
}

async function getAvailableModels(port) {
    const raw = await resolveTargets(port, false);
    const candidates = raw;

    for (const target of candidates) {
        try {
            const client = await CDP({ target: target.webSocketDebuggerUrl });
            const { Runtime } = client;
            await Runtime.enable();

            // Open model menu first, but avoid toggling it closed if already open.
            const openRes = await Runtime.evaluate({
                expression: `
                    ${DriverFactory.getDriver().getLocatorsScript()}
                    (() => {
                        const existingOptions = AG_UI.getModelOptions().filter(AG_UI.isVisible);
                        if (existingOptions.length > 3) return { alreadyOpen: true };
                        const btn = AG_UI.getModelSelectorButton();
                        if (btn) {
                            const ariaControls = btn.getAttribute('aria-controls');
                            const popoverEl = ariaControls ? document.getElementById(ariaControls) : null;
                            const isExpanded = btn.getAttribute('aria-expanded') === 'true' || (popoverEl && AG_UI.isVisible(popoverEl));
                            if (!isExpanded) {
                                const opts = { bubbles: true, cancelable: true, view: window };
                                btn.dispatchEvent(new MouseEvent('pointerdown', opts));
                                btn.dispatchEvent(new MouseEvent('mousedown', opts));
                                btn.dispatchEvent(new MouseEvent('pointerup', opts));
                                btn.dispatchEvent(new MouseEvent('mouseup', opts));
                                btn.dispatchEvent(new MouseEvent('click', opts));
                            }
                            return { clicked: true };
                        }
                        return { clicked: false };
                    })()
                `, returnByValue: true
            });
            const openVal = openRes.result?.value;
            if (!openVal || (!openVal.clicked && !openVal.alreadyOpen)) {
                await client.close();
                continue;
            }

            // Wait for dropdown to open
            await new Promise(r => setTimeout(r, 500));

            const res = await Runtime.evaluate({
                expression: `
                    ${DriverFactory.getDriver().getLocatorsScript()}
                    (() => {
                        const cleanModelText = (text) => (text || '')
                            .replace(/Fla\\s*h/g, 'Flash')
                            .replace(/Fa\\s*t/g, 'Fast')
                            .replace(/\\bopus?\\b/gi, 'Opus')
                            .replace(/(Fast|New)\\s*$/, '')
                            .replace(/\\s+/g, ' ')
                            .trim();
                        
                        const isModelName = (t) => /^(gemini|claude|gpt|opus|sonnet|flash|llama|mistral|deepseek)/i.test(t);
                        
                        const seen = new Set();
                        const models = [];
                        
                        // First try AG_UI approach (IDE)
                        const agItems = AG_UI.getModelOptions();
                        agItems.forEach(el => {
                            if (AG_UI.isVisible(el)) {
                                const t = cleanModelText(el.textContent.trim().split('\\n')[0].trim());
                                if (t.length > 2 && t.length < 80 && !seen.has(t)) { seen.add(t); models.push(t); }
                            }
                        });
                        
                        // If IDE approach found models, use them
                        if (models.length > 1) return models;
                        
                        // Standalone fallback: scan all leaf elements for model-like text
                        const allEls = Array.from(document.querySelectorAll('button, [role="option"], [role="menuitem"], li, span, div'));
                        allEls.forEach(el => {
                            if (el.children.length > 3) return; // Skip containers
                            const raw = (el.textContent || '').trim().split('\\n')[0].trim();
                            const t = cleanModelText(raw);
                            if (t.length > 3 && t.length < 80 && isModelName(t) && !seen.has(t)) {
                                seen.add(t);
                                models.push(t);
                            }
                        });
                        
                        return models;
                    })()
                `, returnByValue: true
            });

            await client.close();
            const modelsFound = res.result?.value || [];
            if (modelsFound.length > 1) {
                return modelsFound;
            }
        } catch(e) {}
    }
    return [];
}

async function selectModel(port, modelName, specificTargetId = null) {
    const raw = await resolveTargets(port, false);
    let candidates = raw;
    if (specificTargetId) {
        candidates = candidates.filter(t => t.id === specificTargetId);
    }

    for (const target of candidates) {
        try {
            const client = await CDP({ target: target.webSocketDebuggerUrl });
            const { Runtime } = client;
            await Runtime.enable();

            // Step 1: Open dropdown
            const openRes = await Runtime.evaluate({
                expression: `
                    ${DriverFactory.getDriver().getLocatorsScript()}
                    (() => {
                        const existingOptions = AG_UI.getModelOptions().filter(AG_UI.isVisible);
                        if (existingOptions.length > 3) return { alreadyOpen: true };
                        const btn = AG_UI.getModelSelectorButton();
                        if (btn) {
                            const ariaControls = btn.getAttribute('aria-controls');
                            const popoverEl = ariaControls ? document.getElementById(ariaControls) : null;
                            const isExpanded = btn.getAttribute('aria-expanded') === 'true' || (popoverEl && AG_UI.isVisible(popoverEl));
                            if (!isExpanded) {
                                const opts = { bubbles: true, cancelable: true, view: window };
                                btn.dispatchEvent(new MouseEvent('pointerdown', opts));
                                btn.dispatchEvent(new MouseEvent('mousedown', opts));
                                btn.dispatchEvent(new MouseEvent('pointerup', opts));
                                btn.dispatchEvent(new MouseEvent("mouseup", opts));
                                btn.dispatchEvent(new MouseEvent('click', opts));
                            }
                            return { clicked: true };
                        }
                        return { clicked: false };
                    })()
                `, returnByValue: true
            });
            const openVal = openRes.result?.value;
            if (!openVal || (!openVal.clicked && !openVal.alreadyOpen)) {
                await client.close();
                continue;
            }

            await new Promise(r => setTimeout(r, 600));

            // Step 2: Find and click the model
            const selectRes = await Runtime.evaluate({
                expression: `
                    ${DriverFactory.getDriver().getLocatorsScript()}
                    (() => {
                        const normalizeModelText = (text) => (text || '')
                            .toLowerCase()
                            .replace(/选择模型/g, ' ')
                            .replace(/select model/g, ' ')
                            .replace(/current/g, ' ')
                            .replace(/当前/g, ' ')
                            .replace(/fla\\s*h/g, 'flash')
                            .replace(/fa\\s*t/g, 'fast')
                            .replace(/\\bopus?\\b/g, 'opus')
                            .replace(/\\bfast\\b/g, ' ')
                            .replace(/\\bnew\\b/g, ' ')
                            .replace(/[^a-z0-9]+/g, '');
                        const targetModel = normalizeModelText(${JSON.stringify(modelName)});

                        // IDE approach: visible model options
                        let candidateList = AG_UI.getModelOptions().filter(AG_UI.isVisible);

                        // Standalone fallback: scan buttons/list items
                        if (candidateList.length < 2) {
                            candidateList = Array.from(document.querySelectorAll('button, [role="option"], [role="menuitem"], li'))
                                .filter(el => {
                                    const t = (el.textContent || '').trim();
                                    return t.length > 2 && t.length < 100 && /gemini|claude|gpt|opus|sonnet|flash|llama|mistral|deepseek/i.test(t);
                                });
                        }

                        // Exact match first
                        let match = candidateList.find(b => normalizeModelText(b.textContent) === targetModel);

                        // Partial match
                        if (!match) {
                            match = candidateList.find(b => {
                                const text = normalizeModelText(b.textContent);
                                return text.includes(targetModel) || targetModel.includes(text);
                            });
                        }

                        if (match) {
                            const opts = { bubbles: true, cancelable: true, view: window };
                            match.dispatchEvent(new MouseEvent('pointerdown', opts));
                            match.dispatchEvent(new MouseEvent('mousedown', opts));
                            match.dispatchEvent(new MouseEvent('pointerup', opts));
                            match.dispatchEvent(new MouseEvent('mouseup', opts));
                            match.dispatchEvent(new MouseEvent('click', opts));
                            return { selected: true, modelText: match.textContent.trim().split('\\n')[0].trim() };
                        }

                        return { selected: false, available: candidateList.map(b => (b.textContent || '').trim().split('\\n')[0].substring(0, 50)) };
                    })()
                `, returnByValue: true
            });

            await client.close();
            const selectVal = selectRes.result?.value;
            if (selectVal && selectVal.selected) {
                return true;
            }
        } catch(e) {}
    }
    return false;
}

async function stopAgent(port) {
    const candidates = await resolveTargets(port, false);

    for (const target of candidates) {
        try {
            const client = await CDP({ target: target.webSocketDebuggerUrl });
            const { Runtime } = client;
            await Runtime.enable();

            const res = await Runtime.evaluate({
                expression: `
                    ${DriverFactory.getDriver().getLocatorsScript()}
                    (() => {
                        // First try the real stop button (agent generating)
                        const btn = AG_UI.getStopButton();
                        if (btn) {
                            btn.click();
                            return { stopped: true, method: 'stop' };
                        }
                        // Fallback: if an interactive modal is open, click Skip/Atla
                        const chatArea = AG_UI.getVisibleChatContainer() || document;
                        const allBtns = Array.from(chatArea.querySelectorAll('button')).filter(b => b.offsetParent !== null);
                        const skipBtn = allBtns.find(b => {
                            const t = (b.textContent || '').trim().toLowerCase();
                            return t === 'skip' || t === 'atla';
                        });
                        if (skipBtn) {
                            skipBtn.click();
                            return { stopped: true, method: 'skip' };
                        }
                        return { stopped: false };
                    })()
                `, returnByValue: true
            });

            await client.close();
            return res.result?.value?.stopped || false;
        } catch(e) {}
    }
    return false;
}

async function getQuota(_port, t, returnRaw = false) {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const https = require('https');
    const execAsync = promisify(exec);

    try {
        // 1. Detect Antigravity language server process and extract csrf_token + ports
        const { stdout } = await execAsync('ps aux');
        const psLines = stdout.split('\n');
        let csrfToken = null;
        let lsPid = null;

        for (const line of psLines) {
            if (!line.toLowerCase().includes('antigravity')) continue;
            if (!line.includes('language_server') && !line.includes('--csrf_token')) continue;
            if (line.includes('grep')) continue;
            const csrfMatch = line.match(/--csrf_token\s+([^\s]+)/);
            if (csrfMatch) csrfToken = csrfMatch[1];
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) lsPid = parseInt(parts[1], 10);
            if (csrfToken) break;
        }

        if (!csrfToken || !lsPid) {
            console.log('[Quota] Language server not found');
            return null;
        }
        console.log(`[Quota] LS found: PID=${lsPid}, token=${csrfToken.substring(0, 8)}...`);

        // 2. Discover ports the language server is listening on
        let ports = [];
        try {
            const { stdout: ssOut } = await execAsync(`ss -tlnp | grep "pid=${lsPid},"`);
            for (const l of ssOut.split('\n')) {
                const m = l.match(/:(\d+)\s/);
                if (m) { const p = parseInt(m[1], 10); if (!isNaN(p) && !ports.includes(p)) ports.push(p); }
            }
        } catch(e) {
            try {
                const { stdout: lsofOut } = await execAsync(`lsof -nP -iTCP -sTCP:LISTEN -a -p ${lsPid}`);
                for (const l of lsofOut.split('\n')) {
                    const m = l.match(/:(\d+)\s+\(LISTEN\)/);
                    if (m) { const p = parseInt(m[1], 10); if (!isNaN(p) && !ports.includes(p)) ports.push(p); }
                }
            } catch(e2) {}
        }

        if (ports.length === 0) { console.log('[Quota] LS port not found'); return null; }
        console.log(`[Quota] Portlar: ${ports.join(', ')}`);

        // 3. Probe ports with Connect RPC GetUserStatus
        const RPC_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
        const body = JSON.stringify({ metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } });

        function probePort(p, protocol) {
            return new Promise((resolve) => {
                const mod = protocol === 'https' ? https : http;
                const req = mod.request({
                    hostname: '127.0.0.1', port: p, path: RPC_PATH, method: 'POST',
                    timeout: 3000, rejectUnauthorized: false,
                    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Codeium-Csrf-Token': csrfToken }
                }, (res) => {
                    let d = '';
                    res.on('data', c => d += c);
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            try { resolve(JSON.parse(d)); } catch(e) { resolve(null); }
                        } else { resolve(null); }
                    });
                });
                req.on('error', () => resolve(null));
                req.on('timeout', () => { req.destroy(); resolve(null); });
                req.write(body);
                req.end();
            });
        }

        let apiData = null;
        for (const p of ports) {
            apiData = await probePort(p, 'https');
            if (apiData) break;
            apiData = await probePort(p, 'http');
            if (apiData) break;
        }

        if (!apiData) { console.log('[Quota] No Connect RPC response'); return null; }
        console.log('[Quota] API response received');
        if (returnRaw) return apiData;

        // 4. Format the response
        const userStatus = apiData.userStatus || apiData;
        const result = [];

        result.push(t ? t('quota.header') : '📊 Hesap ve Kota Bilgisi\n');
        if (userStatus.email) result.push(`👤 ${userStatus.email}`);

        // AI Credits from userTier.availableCredits
        const userTier = userStatus.userTier;
        if (userTier) {
            if (userTier.name) result.push(t ? t('quota.plan', { plan: userTier.name }) : `📋 Plan: ${userTier.name}`);
            const credits = userTier.availableCredits;
            if (Array.isArray(credits) && credits.length > 0) {
                const c = credits[0];
                const amount = parseInt(c.creditAmount, 10);
                if (!isNaN(amount)) {
                    result.push(`💰 AI Credits: ${amount.toLocaleString()}`);
                }
            }
        }

        // Prompt Credits
        const planStatus = userStatus.planStatus;
        if (planStatus && typeof planStatus.availablePromptCredits === 'number') {
            const availStr = planStatus.availablePromptCredits.toLocaleString();
            const monthlyStr = planStatus.planInfo?.monthlyPromptCredits ? ` / ${planStatus.planInfo.monthlyPromptCredits.toLocaleString()}` : '';
            result.push(t ? t('quota.prompt_credits', { available: availStr, monthly: monthlyStr }) : `📊 Prompt Credits: ${availStr}${monthlyStr}`);
        }

        const configs = userStatus.cascadeModelConfigData?.clientModelConfigs;
        if (Array.isArray(configs) && configs.length > 0) {
            result.push('');
            result.push(t ? t('quota.model_quota') : '⏱️ Model Kota Durumu:');

            // Sort models: Gemini > Claude > others
            const priority = (label) => {
                if (label.includes('Gemini')) return 0;
                if (label.includes('Claude')) return 1;
                return 2;
            };
            const sorted = [...configs].sort((a, b) => priority(a.label || '') - priority(b.label || ''));

            for (const m of sorted) {
                const modelId = m.modelOrAlias?.model || 'unknown';
                const label = m.label || modelId;
                // Skip autocomplete models and GPT-OSS
                if (modelId.includes('gemini-2.5') || label.includes('Gemini 2.5')) continue;
                if (modelId.includes('GPT_OSS') || label.includes('GPT-OSS') || label.includes('GPT OSS')) continue;
                // Skip base models and redundant Medium/Low tiers to keep the list clean
                if (label.includes('Gemini 1.5')) continue;
                if (label.includes('(Medium)') || label.includes('(Low)')) continue;

                let line = `🤖 ${label}`;
                if (m.quotaInfo) {
                    const rem = m.quotaInfo.remainingFraction;
                    if (rem !== undefined) {
                        const pct = Math.round(rem * 100);
                        const bars = Math.round(rem * 8);
                        const filled = '█'.repeat(bars);
                        const empty = '▒'.repeat(8 - bars);
                        let icon = '🟢';
                        if (pct < 50) icon = '🟡';
                        if (pct < 15) icon = '🔴';
                        line += t ? t('quota.remaining_pct', { pct: pct, icon: icon, filled: filled, empty: empty }) : ` ${icon} ${filled}${empty} ${pct}% remaining`;
                    }
                    if (m.quotaInfo.resetTime) {
                        try {
                            const rt = new Date(m.quotaInfo.resetTime);
                            const diff = rt - new Date();
                            if (diff > 0) {
                                const hrs = Math.floor(diff / 3600000);
                                const mins = Math.floor((diff % 3600000) / 60000);
                                line += t ? t('quota.reset_time', { hours: hrs, mins: mins }) : ` ⏳ ${hrs}sa ${mins}dk`;
                            }
                        } catch(e) {}
                    }
                    if (rem === 0) line += t ? t('quota.empty') : ' ⛔ EXHAUSTED';
                }
                result.push(line);
            }
        }

        return result.length > 0 ? result.join('\n') : null;
    } catch(e) {
        console.error('[Quota] Hata:', e.message);
        return null;
    }
}

async function closeWindow(port) {
    const candidates = await resolveTargets(port, false);
    if (candidates.length === 0) return false;

    const target = candidates[0]; // first candidate is the preferred window if set
    const targetId = target.id;

    // Stage 1: Graceful close via window.close()
    // This triggers Electron's beforeunload/close event handlers,
    // which flush state.vscdb (chat history, settings) to disk.
    // Without this, Target.closeTarget kills the window instantly
    // and Electron may not persist its internal state.
    let gracefulOk = false;
    try {
        const client = await CDP({ target: target.webSocketDebuggerUrl });
        const { Runtime } = client;
        await Runtime.enable();
        await Runtime.evaluate({ expression: 'window.close()' });
        await client.close();
        gracefulOk = true;
        console.log(`[closeWindow] Stage 1: window.close() sent to ${targetId.substring(0, 8)}`);
    } catch (e) {
        console.log(`[closeWindow] Stage 1 failed (${e.message}), proceeding to fallback`);
    }

    // Wait for Electron to flush state to disk (state.vscdb write)
    // 2 seconds is generous — typical flush takes <500ms
    if (gracefulOk) {
        await new Promise(r => setTimeout(r, 2000));
    }

    // Stage 2: Verify the window is gone, force-close if still alive
    try {
        const currentTargets = await resolveTargets(port, false).catch(() => []);
        const stillAlive = currentTargets.some(t => t.id === targetId);

        if (stillAlive) {
            console.log(`[closeWindow] Stage 2: window still alive, force-closing via Target.closeTarget`);
            try {
                const client2 = await CDP({ port });
                const { Target } = client2;
                await Target.closeTarget({ targetId });
                await client2.close();
            } catch (e2) {
                console.log(`[closeWindow] Target.closeTarget fallback failed: ${e2.message}`);
            }
        } else {
            console.log(`[closeWindow] Window closed gracefully`);
        }
    } catch (_) {}

    if (preferredTargetId === targetId) {
        preferredTargetId = null;
    }
    return true;
}

async function closeAllEditors(port) {
    const activeTarget = await resolveTargets(port, true);
    if (!activeTarget) throw new Error("No active workspace found.");
    
    const client = await CDP({ port, target: activeTarget.webSocketDebuggerUrl });
    const { Runtime } = client;
    await Runtime.enable();
    
    const count = await Runtime.evaluate({
        expression: `
            (function() {
                const tabs = document.querySelectorAll('.tab [title^="Close"], .tab [aria-label^="Close"]');
                let c = 0;
                tabs.forEach(t => { t.click(); c++; });
                return c;
            })()
        `, returnByValue: true
    });
    await client.close();
    return count?.result?.value || 0;
}
