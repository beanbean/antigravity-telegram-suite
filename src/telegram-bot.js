require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { exec } = require('child_process');
const { loadLocale, t, getLang } = require('./i18n');
const axios = require('axios');
const { extractFinancialInfo } = require('./finance/ai');
const { addTransaction, updateBillingStatement, getCreditCards, getSpentAmountThisCycle } = require('./finance/db');
const { startCronJobs } = require('./finance/cron');
const { config, isIDERunning, killIDE, cleanLockFile, launchIDE, trustWorkspaceViaCDP, PLATFORM } = require('./platform');
const { isAgentWorking, getFullLatestResponse, snapshotChatState, captureAgentScreenshot, captureFullIDEScreenshot, waitForAgentResponse, sendViaCDP, triggerNewChat, triggerModelMenu, getAvailableModels, selectModel, getCurrentModel, stopAgent, getQuota, listWindows, setPreferredWindow, getPreferredWindow, getPreferredTargetId, getCachedWindows, closeWindow, listAgentThreads, switchAgentThread, getActiveThreadId, getActiveThreadInfo, setActiveWorkspace, switchStandaloneWorkspace, getLastResolvedThreadId, setOnThreadResolved } = require('./cdp_controller');
const autoaccept = require('./autoaccept');
const updater = require('./updater');
const { runTurboOrchestration } = require('./turbo_orchestrator');
const TaskWatcher = require('./task_watcher');
const { extractLocalImageMarkdown } = require('./local_media');
const { ensureCdpReady, isConnectionRefusedError } = require('./cdp_health');
let scheduleClient = null;
try {
    scheduleClient = require('./schedule_client');
} catch (e) {
    console.log('[CronCrew] schedule_client.js not found — schedule features disabled.');
}

// ===== CLAUDE CODE ENGINE =====
const { sendToClaude, cancelSession, resetSession, isSessionActive, getSessionInfo, setActiveSession, getLastSessionId } = require('./claude-controller');
const { listSessions, getLatestSessionId, formatRelativeTime } = require('./session-store');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_WORK_DIR = process.env.CLAUDE_WORK_DIR || process.env.HOME;
const CLAUDE_TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT) || 900000;
const CLAUDE_SKIP_PERMS = process.env.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS === 'true';

// Engine state — persists across restarts
const ENGINE_STATE_FILE = path.join(os.homedir(), '.gemini', 'antigravity', 'engine.txt');
function loadEngine() {
    try { return fs.readFileSync(ENGINE_STATE_FILE, 'utf-8').trim() || 'antigravity'; }
    catch { return 'antigravity'; }
}
function saveEngine(e) {
    try { fs.writeFileSync(ENGINE_STATE_FILE, e); } catch {}
}
let currentEngine = loadEngine(); // 'antigravity' | 'claude'

const CLAUDE_MODEL_STATE_FILE = path.join(os.homedir(), '.gemini', 'antigravity', 'claude_model.txt');
function loadClaudeModel() {
    try { return fs.readFileSync(CLAUDE_MODEL_STATE_FILE, 'utf-8').trim() || 'claude-3-7-sonnet'; }
    catch { return 'claude-3-7-sonnet'; }
}
function saveClaudeModel(m) {
    try { fs.writeFileSync(CLAUDE_MODEL_STATE_FILE, m); } catch {}
}
let currentClaudeModel = loadClaudeModel();

const TURBO_STATE_FILE = path.join(os.homedir(), '.gemini', 'antigravity', 'turbo_state.json');
const RESTART_FLAG_FILE = path.join(os.homedir(), '.gemini', 'antigravity', '.restart_pending');

function loadTurboState() {
    try {
        if (fs.existsSync(TURBO_STATE_FILE)) {
            return JSON.parse(fs.readFileSync(TURBO_STATE_FILE, 'utf-8'));
        }
    } catch (e) {}
    return { active: false, pinnedMsgId: null };
}

function saveTurboState() {
    try {
        fs.writeFileSync(TURBO_STATE_FILE, JSON.stringify({ active: isTurboMode, pinnedMsgId: turboPinnedMsgId }));
    } catch (e) {}
}

const initialTurboState = loadTurboState();
let isTurboMode = initialTurboState.active;
let turboPinnedMsgId = initialTurboState.pinnedMsgId;

let cachedAgentThreads = [];
let cachedArtifacts = [];

const MAP_FILE_PATH = path.join(os.homedir(), '.gemini', 'antigravity', 'message_target_map.json');
function loadMessageTargetMap() {
    try {
        if (fs.existsSync(MAP_FILE_PATH)) {
            return new Map(JSON.parse(fs.readFileSync(MAP_FILE_PATH, 'utf-8')));
        }
    } catch (err) { console.error('Failed to load messageTargetMap:', err.message); }
    return new Map();
}
function saveMessageTargetMap(map) {
    try {
        if (map.size > 2000) {
            const trimmed = Array.from(map.entries()).slice(-2000);
            map.clear();
            trimmed.forEach(([k, v]) => map.set(k, v));
        }
        fs.writeFileSync(MAP_FILE_PATH, JSON.stringify(Array.from(map.entries())));
    } catch (err) { console.error('Failed to save messageTargetMap:', err.message); }
}
const messageTargetMap = loadMessageTargetMap();
const textMessageQueues = new Map();

const LANG_STATE_FILE = path.join(os.homedir(), '.gemini', 'antigravity', 'lang.txt');

function loadSavedLang() {
    try {
        if (fs.existsSync(LANG_STATE_FILE)) {
            const saved = fs.readFileSync(LANG_STATE_FILE, 'utf-8').trim();
            if (saved) return saved;
        }
    } catch (e) {}
    return process.env.LANGUAGE || 'en';
}

function saveLangState(langCode) {
    try {
        fs.writeFileSync(LANG_STATE_FILE, langCode);
    } catch (e) {}
}

// Load configured language
const lang = loadSavedLang();
loadLocale(lang);

// ===== SECURITY: ALLOWED_CHAT_ID is mandatory =====
const ALLOWED_CHAT_IDS = process.env.ALLOWED_CHAT_ID ? process.env.ALLOWED_CHAT_ID.split(',').map(id => id.trim()).filter(id => id) : [];
if (ALLOWED_CHAT_IDS.length === 0) {
    if (process.env.SETUP_MODE === 'true') {
        console.warn('\n⚠️  SETUP MODE: Bot is running without ALLOWED_CHAT_ID.');
        console.warn('Send /start to your bot to discover your chat ID.\n');
    } else {
        console.error('\n❌ SECURITY ERROR: ALLOWED_CHAT_ID is required.\n');
        console.error('Set ALLOWED_CHAT_ID in your .env file to your Telegram chat ID. (You can use a comma-separated list of IDs)');
        console.error('Send /start to your bot to discover your chat ID.');
        console.error('Tip: Set SETUP_MODE=true in .env to run without ALLOWED_CHAT_ID during initial setup.\n');
        process.exit(1);
    }
}

const bot = new Telegraf(process.env.BOT_TOKEN, { handlerTimeout: 900000 }); // 15 minutes timeout to allow long /ask requests

startCronJobs(bot); // Khởi chạy finance cron jobs
const { startBrain2Cron, isCronReply, buildCronContext, sendTestCron } = require('./brain2-cron');
startBrain2Cron(bot); // Brain2 autonomous cron (03h/06h/09h/20h)

// /testcron — send a test Brain2 cron message for reply testing
bot.command('testcron', async (ctx) => {
    try {
        await sendTestCron(bot);
        ctx.reply('✅ Test cron sent — reply tin đó để test context flow');
    } catch (e) {
        ctx.reply('❌ ' + e.message);
    }
});

// --- FINANCE BOT COMMANDS ---
bot.command('tuvan', async (ctx) => {
  const amountStr = ctx.message.text.split(' ')[1];
  if (!amountStr) {
    return ctx.reply('Sử dụng lệnh: /tuvan [số tiền cần thanh toán]\nVí dụ: /tuvan 15000000');
  }
  
  const amount = parseInt(amountStr, 10);
  if (isNaN(amount)) return ctx.reply('Số tiền không hợp lệ.');

  try {
    const cards = await getCreditCards();
    if (!cards || cards.length === 0) return ctx.reply('Chưa có thông tin thẻ trong Database.');
    
    let bestCard = null;
    let maxCashback = 0;
    
    for (const card of cards) {
       const spentThisCycle = await getSpentAmountThisCycle(card.id, card.statement_date);
       const maxCb = parseInt(card.max_cashback_amount, 10) || 0;
       const cbPercent = parseFloat(card.cashback_percent) / 100 || 0;
       
       if (cbPercent > 0 && maxCb > 0) {
           const cashbackAlreadyEarned = spentThisCycle * cbPercent;
           const cashbackRoom = maxCb - cashbackAlreadyEarned;
           
           if (cashbackRoom > 0) {
               const potentialCashback = amount * cbPercent;
               const actualCashback = Math.min(potentialCashback, cashbackRoom);
               
               if (actualCashback > maxCashback) {
                   maxCashback = actualCashback;
                   bestCard = card;
               }
           }
       }
    }
    
    if (bestCard) {
      const cbPercent = parseFloat(bestCard.cashback_percent) / 100 || 0;
      const spentThisCycle = await getSpentAmountThisCycle(bestCard.id, bestCard.statement_date);
      const cbRoom = parseInt(bestCard.max_cashback_amount, 10) - (spentThisCycle * cbPercent);
      ctx.reply(`🎯 Đề xuất Thẻ: ${bestCard.name}\n💰 Dự kiến Cashback thu về: ${Math.round(maxCashback).toLocaleString()} VND\n💳 % Hoàn tiền: ${bestCard.cashback_percent}%\n(Hạn mức hoàn tiền còn lại trong kỳ: ${Math.round(cbRoom).toLocaleString()} VND)`);
    } else {
      ctx.reply('Không tìm thấy thẻ nào phù hợp hạn mức lúc này.');
    }
  } catch (error) {
    console.error(error);
    ctx.reply('Lỗi truy xuất dữ liệu thẻ.');
  }
});
// ----------------------------

let isTurboRunning = false;

// Safe commands/buttons that can pass through during turbo execution
const TURBO_SAFE_COMMANDS = [
    '/turbo', '/stop', '/screenshot', '/latest', '/status',
    '/quota', '/help', '/version', '/panel', '/menu',
    '/file', '/cmd', '/autoaccept', '/lang', '/window',
    '/artifacts', '/restart'
];
const TURBO_SAFE_BUTTONS = [
    '📸', '💬', '📦', '📊', '🚀'
];

// Middleware to prevent project switching or concurrent tasks while Turbo Mode is executing
bot.use(async (ctx, next) => {
    if (isTurboRunning) {
        const text = ctx.message?.text || '';
        const cbData = ctx.callbackQuery?.data || '';
        
        if (text) {
            // Check exact match for /start to prevent bypassing with /start_ide and /start_ag
            if (text.trim() === '/start') {
                return next();
            }
            const isSafeCmd = TURBO_SAFE_COMMANDS.some(cmd => text.startsWith(cmd));
            const isSafeBtn = TURBO_SAFE_BUTTONS.some(btn => text.startsWith(btn));
            if (isSafeCmd || isSafeBtn) {
                return next();
            }
            return ctx.reply('⏳ Turbo Mode is currently running! Are you sure you want to stop it?', Markup.inlineKeyboard([
                [Markup.button.callback('🛑 Force Stop Turbo', 'turbo_force_stop')],
                [Markup.button.callback('❌ Cancel', 'turbo_cancel')]
            ]));
        } else if (cbData) {
            if (cbData.startsWith('file_') || cbData.startsWith('artifact_') || cbData.startsWith('turbo_')) {
                return next();
            }
            return ctx.answerCbQuery(t('turbo.is_running_short') || '⏳ Please wait', { show_alert: true }).catch(()=>{});
        } else if (ctx.message?.photo || ctx.message?.document) {
            // Block file/photo uploads during turbo as they trigger sendViaCDP paste
            return ctx.reply('⏳ Turbo Mode is currently running! Are you sure you want to stop it?', Markup.inlineKeyboard([
                [Markup.button.callback('🛑 Force Stop Turbo', 'turbo_force_stop')],
                [Markup.button.callback('❌ Cancel', 'turbo_cancel')]
            ]));
        }
    }
    return next();
});
function getCDPPort(app = process.env.ANTIGRAVITY_PREFERRED_APP || 'agent') {
    if (app === 'ide') {
        return parseInt(process.env.IDE_CDP_PORT || '9334', 10);
    }
    return parseInt(process.env.AGENT_CDP_PORT || process.env.DEBUGGING_PORT || '9333', 10);
}
let CDP_PORT = getCDPPort();

async function sendViaCDPWithRecovery(text, specificTargetId = null) {
    const app = config.preferredApp || 'agent';
    await ensureCdpReady({ port: CDP_PORT, app });
    try {
        return await sendViaCDP(text, CDP_PORT, specificTargetId);
    } catch (err) {
        if (!isConnectionRefusedError(err)) {
            throw err;
        }
        console.warn(`[cdp] Port ${CDP_PORT} refused connection; restarting ${app} with CDP and retrying once.`);
        await ensureCdpReady({ port: CDP_PORT, app });
        return sendViaCDP(text, CDP_PORT, null);
    }
}

function updateEnvFile(key, value) {
    const envPath = path.join(__dirname, '..', '.env');
    let content = '';
    try {
        if (fs.existsSync(envPath)) {
            content = fs.readFileSync(envPath, 'utf8');
        } else {
            const examplePath = path.join(__dirname, '..', '.env.example');
            if (fs.existsSync(examplePath)) {
                content = fs.readFileSync(examplePath, 'utf8');
            }
        }
    } catch (e) {
        console.error('Failed to read .env file:', e.message);
    }

    const lines = content.split(/\r?\n/);
    let keyUpdated = false;
    const newLines = lines.map(line => {
        if (line.trim().startsWith(`${key}=`)) {
            keyUpdated = true;
            return `${key}=${value}`;
        }
        return line;
    });

    if (!keyUpdated) {
        newLines.push(`${key}=${value}`);
    }

    try {
        fs.writeFileSync(envPath, newLines.join('\n'), 'utf8');
        process.env[key] = value;
        return true;
    } catch (e) {
        console.error('Failed to write .env file:', e.message);
        return false;
    }
}

function markdownToTelegramHtml(text) {
    let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    
    // Code blocks
    let codeBlocks = [];
    html = html.replace(/```([a-z0-9]*)\n([\s\S]*?)```/g, (match, lang, code) => {
        let placeholder = `@@@CODEBLOCK_${codeBlocks.length}@@@`;
        if (lang) {
            codeBlocks.push(`<pre><code class="language-${lang}">${code}</code></pre>`);
        } else {
            codeBlocks.push(`<pre>${code}</pre>`);
        }
        return placeholder;
    });

    html = html.replace(/`([^`]+)`/g, (match, code) => {
        let placeholder = `@@@INLINECODE_${codeBlocks.length}@@@`;
        codeBlocks.push(`<code>${code}</code>`);
        return placeholder;
    });

    html = html.replace(/^(#{1,6})\s+(.+)$/gm, '<b>$2</b>');
    html = html.replace(/\*\*([^\*]+)\*\*/g, '<b>$1</b>');
    html = html.replace(/(?<![A-Za-z0-9])\*([^\*]+)\*(?![A-Za-z0-9])/g, '<i>$1</i>');
    html = html.replace(/(?<![A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9])/g, '<i>$1</i>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    
    // Lists
    html = html.replace(/^(\s*)-\s+(.+)$/gm, '$1• $2');
    
    html = html.replace(/\[x\]/ig, '✅');
    html = html.replace(/\[ \]/g, '⬜');
    html = html.replace(/\[\/\]/g, '🔄');

    // Blockquotes
    html = html.replace(/^&gt;\s?(.*)$/gm, '<blockquote expandable>$1</blockquote>');
    html = html.replace(/<\/blockquote>\n<blockquote expandable>/g, '\n');

    // Tables
    const tableRegex = /^(\|.*\|[\r\n]+)+\|.*\|/gm;
    html = html.replace(tableRegex, (match) => {
        const lines = match.trim().split('\n');
        if (lines.length < 2) return match;
        if (!lines[1].includes('---') && !lines[1].includes(':-')) return match;
        
        const rows = lines.map(line => line.trim().split('|'));
        const colWidths = [];
        for (let r = 0; r < rows.length; r++) {
            for (let c = 0; c < rows[r].length; c++) {
                const cleanCell = rows[r][c].trim().replace(/<[^>]*>/g, '').replace(/@@@INLINECODE_\d+@@@/g, 'inline');
                if (!colWidths[c] || cleanCell.length > colWidths[c]) {
                    colWidths[c] = cleanCell.length;
                }
            }
        }
        
        let paddedMatch = rows.map((row, r) => {
            if (r === 1 && row.join('').replace(/-/g, '').replace(/:/g, '').trim() === '') {
                return '|' + row.map((cell, c) => {
                    if (c === 0 || c === row.length - 1) return '';
                    return '-'.repeat(colWidths[c] + 2);
                }).filter(Boolean).join('|') + '|';
            }
            return '|' + row.map((cell, c) => {
                if (c === 0 || c === row.length - 1) return '';
                const cleanCell = cell.trim().replace(/<[^>]*>/g, '').replace(/@@@INLINECODE_\d+@@@/g, 'inline');
                const padLen = Math.max(0, colWidths[c] - cleanCell.length);
                return ' ' + cell.trim() + ' '.repeat(padLen) + ' ';
            }).filter(Boolean).join('|') + '|';
        }).join('\n');
        
        return `<pre>${paddedMatch}</pre>`;
    });

    codeBlocks.forEach((code, index) => {
        html = html.replace(`@@@CODEBLOCK_${index}@@@`, code);
        html = html.replace(`@@@INLINECODE_${index}@@@`, code);
    });

    return html;
}

function downloadLocalImageUrl(rawUrl) {
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(rawUrl);
        } catch (err) {
            reject(err);
            return;
        }

        const client = parsed.protocol === 'https:' ? https : http;
        const onResponse = (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }

            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const filename = path.basename(parsed.pathname) || 'image';
                resolve({ buffer: Buffer.concat(chunks), filename });
            });
        };
        const req = parsed.protocol === 'https:'
            ? client.get(parsed, { rejectUnauthorized: false }, onResponse)
            : client.get(parsed, onResponse);

        req.setTimeout(15000, () => req.destroy(new Error('download timeout')));
        req.on('error', reject);
    });
}

async function sendExtractedImage(ctx, image, replyToMsgId = null) {
    const replyOptions = replyToMsgId
        ? { reply_parameters: { message_id: replyToMsgId, allow_sending_without_reply: true } }
        : undefined;

    if (image.type === 'url') {
        const downloaded = await downloadLocalImageUrl(image.path);
        await ctx.replyWithPhoto(
            { source: downloaded.buffer, filename: downloaded.filename },
            replyOptions
        );
        return;
    }

    if (!fs.existsSync(image.path)) {
        console.warn(`[local_media] Image not found: ${image.path}`);
        return;
    }

    await ctx.replyWithPhoto(
        { source: image.path },
        replyOptions
    );
}

// Helper: Send long messages safely within Telegram's 4096 char limit
async function sendLongMessage(ctx, text, prefix = '', buttons = null, replyToMsgId = null) {
    const MAX_LEN = 3500;
    const localMedia = extractLocalImageMarkdown(text);
    text = localMedia.text;

    for (const image of localMedia.images) {
        try {
            await sendExtractedImage(ctx, image, replyToMsgId);
        } catch (err) {
            console.warn(`[local_media] Failed to send image ${image.path}: ${err.message}`);
        }
    }
    
    // Parse text to HTML and preserve prefix formatting
    const htmlText = prefix ? `<b>${prefix}</b>\n\n${markdownToTelegramHtml(text)}` : markdownToTelegramHtml(text);
    
    async function replyWithRetry(content, isPlain = false, kbOpts = null, retries = 3, threadReplyId = null) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const opts = {};
                if (!isPlain) opts.parse_mode = 'HTML';
                
                if (kbOpts) {
                    if (Array.isArray(kbOpts)) {
                        if (kbOpts.length > 0) opts.reply_markup = { inline_keyboard: kbOpts };
                    } else if (kbOpts.reply_markup) {
                        opts.reply_markup = kbOpts.reply_markup;
                    }
                }
                if (threadReplyId) {
                    opts.reply_parameters = { message_id: threadReplyId, allow_sending_without_reply: true };
                }
                return await ctx.reply(content, opts);
            } catch (err) {
                console.error(`sendLongMessage attempt ${attempt}/${retries} failed:`, err.message);
                if (attempt < retries && !err.message.includes("can't parse entities")) {
                    await new Promise(r => setTimeout(r, 2000 * attempt));
                } else if (err.message.includes("can't parse entities") && !isPlain) {
                    // Fallback to sending raw text if HTML parsing completely fails
                    const plain = content.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
                    return await replyWithRetry(plain.substring(0, 4000), true, kbOpts, 1, threadReplyId);
                } else {
                    throw err;
                }
            }
        }
    }

    try {
        const lines = htmlText.split('\n');
        let currentChunk = '';
        let inPre = false;
        let preLang = '';
        let currentReplyId = replyToMsgId;
        const sentMsgIds = [];

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            
            // If a single line is absurdly long, force a split
            if (line.length > MAX_LEN) {
               line = line.substring(0, MAX_LEN) + '...';
            }

            const preMatch = line.match(/<pre>(?:<code class="language-([^"]+)">)?/);
            if (preMatch) {
                inPre = true;
                preLang = preMatch[1] || '';
            }
            if (line.includes('</pre>')) {
                inPre = false;
            }
            
            if (currentChunk.length + line.length > MAX_LEN) {
                if (inPre) {
                    currentChunk += preLang ? '</code></pre>' : '</pre>';
                }
                const sentMsg = await replyWithRetry(currentChunk, false, buttons, 3, currentReplyId);
                if (sentMsg) {
                    currentReplyId = sentMsg.message_id;
                    sentMsgIds.push(sentMsg.message_id);
                }
                currentChunk = inPre ? (preLang ? `<pre><code class="language-${preLang}">\n` : '<pre>\n') : '';
            }
            currentChunk += line + '\n';
        }
        if (currentChunk.trim().length > 0) {
            const sentMsg = await replyWithRetry(currentChunk, false, buttons, 3, currentReplyId);
            if (sentMsg) sentMsgIds.push(sentMsg.message_id);
        }
        console.log(`sendLongMessage: Sent successfully`);
        return sentMsgIds;
    } catch (err) {
        console.error('sendLongMessage final error:', err.message);
        return [];
    }
}

// Strip agent query echo from response text
function stripQueryFromResponse(text, query) {
    const queryTrimmed = query.trim();
    if (text.includes(queryTrimmed)) {
        text = text.substring(text.indexOf(queryTrimmed) + queryTrimmed.length).trim();
    } else if (queryTrimmed.length > 20 && text.startsWith(queryTrimmed.substring(0, 20))) {
        text = text.substring(queryTrimmed.length).trim();
    }
    return text;
}

/**
 * Set an emoji reaction on a message instead of sending a separate info message.
 * Falls back silently if reaction fails (e.g., old Telegram client or unsupported chat type).
 * 
 * Valid Telegram reaction emojis (not all Unicode emojis are allowed):
 * 👍 👎 ❤ 🔥 🎉 🤔 👀 ⚡ 👌 💯 🏆 😁 (and more, but NOT ✅ ❌)
 */
const REACTION = { THINKING: '🤔', SUCCESS: '👍', ERROR: '👎', LOOKING: '👀', FIRE: '🔥' };

async function setReaction(ctx, emoji, messageId = null) {
    try {
        const chatId = ctx.chat.id;
        const msgId = messageId || ctx.message?.message_id;
        if (!msgId) return;
        
        const reaction = emoji ? JSON.stringify([{ type: 'emoji', emoji }]) : '[]';
        await ctx.telegram.callApi('setMessageReaction', {
            chat_id: chatId,
            message_id: msgId,
            reaction
        });
    } catch (e) {
        // Silently fail — reactions may not be supported in all chat types
        console.debug(`[setReaction] Failed: ${e.message}`);
    }
}

// Typing-aware progress callback factory
function createProgressHandler(ctx) {
    return (msg) => {
        if (msg === 'typing') {
            ctx.sendChatAction('typing').catch(() => {});
        } else {
            ctx.reply(msg).catch(() => {});
        }
    };
}

function checkAuth(ctx, next) {
    if (ALLOWED_CHAT_IDS.length === 0) {
        console.log(`\n🔔 NEW CHAT ID DETECTED: ${ctx.chat.id}`);
        console.log(`Please add ALLOWED_CHAT_ID=${ctx.chat.id} to your .env file and restart.\n`);
        return ctx.reply(t('auth.setup_welcome', { chatId: ctx.chat.id })).catch(e => console.error('[checkAuth]', e.message));
    }
    if (!ALLOWED_CHAT_IDS.includes(ctx.chat.id.toString())) {
        const from = ctx.from || ctx.chat;
        if (from && ALLOWED_CHAT_IDS.length > 0) {
            const username = from.username ? `@${from.username}` : 'N/A';
            const fullName = `${from.first_name || ''} ${from.last_name || ''}`.trim() || t('auth.anonymous');
            
            let actionDetails = t('auth.action', { type: ctx.updateType || t('auth.unknown') });
            if (ctx.message && ctx.message.text) actionDetails = t('auth.message', { text: ctx.message.text });
            else if (ctx.callbackQuery) actionDetails = t('auth.button', { data: ctx.callbackQuery.data });

            const alertMsg = t('auth.unauthorized_attempt', { name: fullName, username, id: from.id, details: actionDetails });
            ctx.telegram.sendMessage(ALLOWED_CHAT_IDS[0], alertMsg, { parse_mode: 'HTML' }).catch(e => console.error('[checkAuth Alert]', e.message));
        }
        // Silently ignore unauthorized access to prevent errors if the user blocked the bot
        return Promise.resolve();
    }
    return next();
}

bot.use(checkAuth);

// ===== COMMANDS =====

bot.start((ctx) => {
    ctx.reply(t('bot.started', { chatId: ctx.chat.id }));
});

async function cleanupAll() {
    console.log('[cleanup] Closing all Antigravity instances before exit...');
    try {
        await killIDE('agent');
    } catch (e) {
        console.error('[cleanup] Failed to kill agent:', e.message);
    }
    try {
        await killIDE('ide');
    } catch (e) {
        console.error('[cleanup] Failed to kill ide:', e.message);
    }
    console.log('[cleanup] All Antigravity instances killed.');
}

bot.command('restart', async (ctx) => {
    await ctx.reply(t('restart.closing'));
    // Write flag file so next boot knows to drop pending updates
    // (prevents the /restart command from being re-processed → infinite loop)
    try { fs.writeFileSync(RESTART_FLAG_FILE, Date.now().toString()); } catch (_) {}
    try {
        await Promise.race([
            bot.stop('SIGTERM'),
            new Promise(r => setTimeout(r, 2000))
        ]);
    } catch (_) {}
    process.exit(0);
});

bot.help((ctx) => {
    const helpMessage = `
${t('help.title')}

${t('help.messaging_title')}
${t('help.messaging_text')}

${t('help.agent_title')}
${t('help.agent_text')}

${t('help.status_title')}
${t('help.status_text')}

${t('help.ide_title')}
${t('help.ide_text')}

${t('help.chat_title')}
${t('help.chat_text')}
    `.trim();
    ctx.reply(helpMessage, { parse_mode: 'HTML' });
});

bot.command('start_ide', async (ctx) => {
    const app = 'ide';
    const running = await isIDERunning(app);
    if (running) {
        return ctx.reply(t('ide.already_running_short'));
    }
    cleanLockFile(app);
    let startingMsg = await ctx.reply(t('ide.starting')).catch(()=>{});
    try {
        const appPort = getCDPPort(app);
        await launchIDE(null, appPort, app);
        if (startingMsg && startingMsg.message_id) {
            ctx.deleteMessage(startingMsg.message_id).catch(()=>{});
        }
        ctx.reply(t('ide.started'));
        setTimeout(() => {
            if (autoaccept.isEnabled) autoaccept.enable(appPort).catch(()=>{});
            const defaultModel = process.env.DEFAULT_MODEL || 'Gemini 3.1 Pro (High)';
            selectModel(appPort, defaultModel).catch(()=>{});
        }, 3000);
    } catch (err) {
        if (err.message === 'IDE_NOT_INSTALLED') {
            ctx.reply(t('ide.not_installed'));
        } else {
            ctx.reply(t('ide.start_failed', { error: err.message }));
        }
    }
});

bot.command('start_ag', async (ctx) => {
    const app = 'agent';
    const running = await isIDERunning(app);
    if (running) {
        return ctx.reply(t('standalone.already_running'));
    }
    cleanLockFile(app);
    let startingMsg = await ctx.reply(t('standalone.starting')).catch(()=>{});
    try {
        const appPort = getCDPPort(app);
        await launchIDE(null, appPort, app);
        if (startingMsg && startingMsg.message_id) {
            ctx.deleteMessage(startingMsg.message_id).catch(()=>{});
        }
        ctx.reply(t('standalone.started'));
        setTimeout(() => {
            if (autoaccept.isEnabled) autoaccept.enable(appPort).catch(()=>{});
            const defaultModel = process.env.DEFAULT_MODEL || 'Gemini 3.1 Pro (High)';
            selectModel(appPort, defaultModel).catch(()=>{});
        }, 3000);
    } catch (err) {
        if (err.message === 'IDE_NOT_INSTALLED') {
            ctx.reply(t('standalone.not_installed'));
        } else {
            ctx.reply(t('ide.init_error', { error: err.message }));
        }
    }
});

bot.command('close_ide', async (ctx) => {
    const app = 'ide';
    const running = await isIDERunning(app);
    if (!running) {
        cleanLockFile(app);
        return ctx.reply(t('ide.already_closed'));
    }
    let closingMsg = await ctx.reply(t('ide.closing')).catch(()=>{});
    await killIDE(app);
    if (closingMsg && closingMsg.message_id) {
        ctx.deleteMessage(closingMsg.message_id).catch(()=>{});
    }
    ctx.reply(t('ide.closed'));
});

bot.command('close_ag', async (ctx) => {
    const app = 'agent';
    const running = await isIDERunning(app);
    if (!running) {
        cleanLockFile(app);
        return ctx.reply(t('standalone.already_closed'));
    }
    let closingMsg = await ctx.reply(t('standalone.closing')).catch(()=>{});
    await killIDE(app);
    if (closingMsg && closingMsg.message_id) {
        ctx.deleteMessage(closingMsg.message_id).catch(()=>{});
    }
    ctx.reply(t('standalone.closed'));
});

bot.command('close', async (ctx) => {
    ctx.reply(t('close.select_prompt'));
});

bot.command('close_window', async (ctx) => {
    let closingMsg = await ctx.reply(t('ide.closing_window') || '🪟 Closing window...').catch(()=>{});
    const success = await closeWindow(CDP_PORT);
    const resultMsg = success ? (t('ide.window_closed') || '✅ Window closed successfully.') : (t('ide.window_close_failed') || '❌ Failed to close window. Is there an open window?');
    if (closingMsg && closingMsg.message_id) {
        ctx.deleteMessage(closingMsg.message_id).catch(()=>{});
    }
    ctx.reply(resultMsg);
});

const handleStatus = async (ctx) => {
    if (typeof currentEngine !== 'undefined' && currentEngine === 'claude') {
        let msg = '📊 <b>Claude Code (CLI) Status</b>\n\n';
        msg += `🤖 Model: <b>${typeof currentClaudeModel !== 'undefined' ? currentClaudeModel : 'Default'}</b>\n`;
        msg += `📁 Workspace: <code>${CLAUDE_WORK_DIR}</code>\n`;
        const { isSessionActive } = require('./claude-controller');
        msg += `⏳ Active Task: ${isSessionActive(String(ctx.chat.id)) ? 'Yes' : 'No'}\n`;
        return ctx.reply(msg, { parse_mode: 'HTML' });
    }
    let msg = t('status.report_title');
    
    const agentCheck = await isIDERunning('agent');
    const ideCheck = await isIDERunning('ide');
    
    const agentCheckStr = agentCheck ? t('status.running_status') : t('status.stopped_status');
    const ideCheckStr = ideCheck ? t('status.running_status') : t('status.stopped_status');
    msg += t('status.standalone_running', { status: agentCheckStr });
    msg += t('status.ide_running', { status: ideCheckStr });
    
    const activeApp = process.env.ANTIGRAVITY_PREFERRED_APP || 'agent';
    msg += t('status.preferred_app_status', { app: activeApp === 'agent' ? 'Standalone' : 'Classic IDE' });
    
    if (currentEngine === 'antigravity') {
        try {
            await getActiveThreadId(CDP_PORT);
            msg += t('status.cdp_active');
        } catch {
            msg += t('status.cdp_inactive');
        }
    }
    
    msg += t('status.telegram_bot');
    
    if (currentEngine === 'antigravity') {
        try {
            const activeInfo = await getActiveThreadInfo(CDP_PORT);
            if (activeInfo) {
                msg += t('status.active_chat');
                msg += t('status.project_area', { workspace: activeInfo.workspace });
                msg += t('status.agent_title', { name: activeInfo.name });
                const currentModel = await getCurrentModel(CDP_PORT);
                if (currentModel) msg += t('status.selected_model', { model: currentModel });
                const isWorking = await isAgentWorking(CDP_PORT);
                const statusStr = isWorking ? t('status.agent_working') : t('status.agent_idle');
                msg += t('status.agent_status', { status: statusStr });
            }
        } catch (e) {
            // silently fail if we can't get chat info
        }
    }

    msg += '\n🔀 <b>Engine:</b> ' + (currentEngine === 'claude' ? 'Claude Code (CLI)' : 'Antigravity (CDP)') + '\n';
    if (currentEngine === 'claude') {
        const cInfo = getSessionInfo(String(ctx.chat.id));
        msg += '🧠 <b>Model:</b> <code>' + (typeof currentClaudeModel !== 'undefined' ? currentClaudeModel : 'claude-3-7-sonnet') + '</code>\n';
        msg += '📋 <b>Session:</b> <code>' + (cInfo.sessionId ? cInfo.sessionId.slice(0,8) + '...' : 'new') + '</code>\n';
        msg += '📁 <b>CWD:</b> <code>' + CLAUDE_WORK_DIR + '</code>\n';
    }
    msg += '🛡️ <b>Auto-Accept:</b> ' + (autoaccept.isEnabled ? t('status.autoaccept_on') : t('status.autoaccept_off')) + '\n';

    ctx.reply(msg, { parse_mode: 'HTML' });
};
bot.command('status', handleStatus);

/**
 * Appends thread info and agent status footer to response text.
 */
async function getChatHeader(targetId = null, fallback = '') {
    try {
        const activeInfo = await getActiveThreadInfo(CDP_PORT, targetId);
        if (activeInfo) {
            const wsName = activeInfo.workspace || 'Workspace';
            let thName = activeInfo.name || 'Agent';
            if (thName.length > 35) {
                const words = thName.split(' ');
                if (words.length > 5) {
                    thName = words.slice(0, 5).join(' ') + '...';
                } else {
                    thName = thName.substring(0, 35) + '...';
                }
            }
            return `📁 ${wsName}\n🤖 ${thName}\n${t('agent.swipe_to_reply')}`;
        }
    } catch (_) {}
    return fallback;
}

async function buildMainMenu(overrideThread = null, overrideWorkspace = null, targetId = null) {
    const preferredApp = process.env.ANTIGRAVITY_PREFERRED_APP || 'agent';
    const isIDE = preferredApp === 'ide';
    let wsName = overrideWorkspace || 'Projects';
    let threadName = overrideThread || null;
    if (!overrideThread && !overrideWorkspace) {
    try {
        const info = await getActiveThreadInfo(CDP_PORT, targetId);
        if (info && info.name) threadName = info.name;
        if (info && info.workspace) {
            wsName = info.workspace.split('/').pop() || info.workspace;
        } else if (typeof currentWorkspaceDir !== 'undefined' && currentWorkspaceDir && currentWorkspaceDir !== config.projectsDir) {
            wsName = require('path').basename(currentWorkspaceDir);
        }
    } catch(e) {
        if (typeof currentWorkspaceDir !== 'undefined' && currentWorkspaceDir && currentWorkspaceDir !== config.projectsDir) {
            wsName = require('path').basename(currentWorkspaceDir);
        }
    }
    } // end if (!overrideThread && !overrideWorkspace)
    let modelName = t('menu.model_not_selected');
    try {
        const m = await getCurrentModel(CDP_PORT);
        if (m) {
            // Kısalt: parantez içindekileri sil (örn. "Claude Opus 4.6 (Thinking)" -> "Claude Opus 4.6")
            modelName = m.replace(/\s*\([^)]*\)/g, '').trim();
        }
    } catch(e) {}

    // IDE aktifken: workspace adı göster (ör. "antigravity-bot")
    // Standalone aktifken: agent/thread adı göster (ör. "Validating Rules...")
    let displayTitle = 'Agent';
    if (isIDE) {
        // IDE mode: workspace name is primary
        if (wsName && wsName !== 'Projects') {
            displayTitle = wsName;
        } else if (threadName && threadName !== 'Launchpad') {
            displayTitle = threadName;
        }
    } else {
        // Standalone mode: thread/agent name is primary
        if (threadName && threadName !== 'Launchpad') {
            displayTitle = threadName;
        } else if (wsName && wsName !== 'Projects') {
            displayTitle = wsName;
        }
    }
    // Başlığı max 20 karaktere kısalt
    if (displayTitle.length > 20) displayTitle = displayTitle.substring(0, 18) + '...';

    if (typeof currentEngine !== 'undefined' && currentEngine === 'claude') {
        const cwDir = process.env.CLAUDE_WORK_DIR || process.env.HOME;
        let cwName = require('path').basename(cwDir);
        if (cwName.length > 20) cwName = cwName.substring(0, 18) + '...';
        return Markup.keyboard([
            [`📁 ${cwName}`, '🧠 Model'],
            ['📋 Session', '🔀 Engine'],
            [
                isTurboMode ? (t('turbo.btn_on') || '🚀 Turbo ✅') : (t('turbo.btn_off') || '🚀 Turbo'), 
                t('btn_skills') || '🛠️ Skills'
            ]
        ]).resize();
    }

    return Markup.keyboard([
        [`🤖 ${displayTitle}`, `🧠 ${modelName}`],
        [
            t('menu.btn_screenshot') || '📸 Screen', 
            t('menu.btn_artifacts') || '📦 Artifacts',
            t('btn_skills') || '🛠️ Skills'
        ],
        [
            isTurboMode ? (t('turbo.btn_on') || '🚀 Turbo ✅') : (t('turbo.btn_off') || '🚀 Turbo'), 
            '🔀 Engine',
            t('menu.btn_latest') || '💬 Latest'
        ]
    ]).resize();
}

async function sendMainMenu(ctx, text = '🕹️ Kontrol Paneli:', overrideThread = null, overrideWorkspace = null, targetId = null, editMessageId = null) {
    const kb = await buildMainMenu(overrideThread, overrideWorkspace, targetId);
    
    if (editMessageId) {
        // We do NOT pass kb here because kb contains a ReplyKeyboardMarkup, which Telegram API 
        // rejects for editMessageText (it expects InlineKeyboardMarkup or none).
        return ctx.telegram.editMessageText(ctx.chat.id, editMessageId, undefined, text, { parse_mode: 'HTML' }).catch(e => {
            console.error('[sendMainMenu] editMessageText failed:', e.message);
            if (!e.message.includes('message is not modified')) {
                return ctx.reply(text, kb);
            }
        });
    }

    if (ctx.callbackQuery && ctx.callbackQuery.message) {
        return ctx.editMessageText(text, kb).catch(e => {
            if (!e.message.includes('message is not modified')) {
                return ctx.reply(text, kb);
            }
        });
    }
    return ctx.reply(text, kb);
}

async function pushMainMenuToUser(text, silent = false) {
    if (ALLOWED_CHAT_IDS.length === 0 || process.env.SETUP_MODE === 'true') return;
    const kb = await buildMainMenu();
    return Promise.all(ALLOWED_CHAT_IDS.map(id => bot.telegram.sendMessage(id, text, { ...kb, disable_notification: silent }).catch(() => {})));
}

bot.command('start', async (ctx) => {
    await sendMainMenu(ctx, t('menu.welcome'));
});

const handleLatest = async (ctx) => {
    if (typeof currentEngine !== 'undefined' && currentEngine === 'claude') {
        return ctx.reply(t('feature.claude_unsupported') || '❌ This feature is currently only available in Antigravity mode.');
    }
    try {
        // Use the preferred target (set by workspace switch or /window command)
        // instead of blindly picking candidates[0] which may be the wrong window
        const targetId = getPreferredTargetId() || null;
        let _latestRes = await getFullLatestResponse(CDP_PORT, targetId);
        let text = typeof _latestRes === 'string' ? _latestRes : _latestRes.text;
        let buttons = typeof _latestRes === 'string' ? null : _latestRes.buttons;
        
        const header = await getChatHeader(targetId, t('latest.title'));
        await sendLongMessage(ctx, text, header, buttons);
    } catch (err) {
        ctx.reply(t('latest.error', { error: err.message }));
    }
};

bot.command('latest', handleLatest);
bot.hears(/^💬/i, handleLatest);

const handleScreenshot = async (ctx) => {
    if (typeof currentEngine !== 'undefined' && currentEngine === 'claude') {
        return ctx.reply(t('feature.claude_unsupported') || '❌ This feature is currently only available in Antigravity mode.');
    }
    try {
        setReaction(ctx, REACTION.THINKING);
        const buffer = await captureFullIDEScreenshot(CDP_PORT);
        await ctx.replyWithPhoto({ source: buffer });
        setReaction(ctx, null);
    } catch (err) {
        setReaction(ctx, null);
        ctx.reply(t('screenshot.error', { error: err.message }));
    }
};
bot.command('screenshot', handleScreenshot);
bot.hears(/^📸/i, handleScreenshot);

bot.command('quota', async (ctx) => {
    try {
        setReaction(ctx, REACTION.THINKING);
        const quotaInfo = await getQuota(CDP_PORT, t);
        if (quotaInfo) {
            ctx.reply(quotaInfo);
        } else {
            ctx.reply(t('quota.not_found'));
        }
    } catch (err) {
        ctx.reply(t('quota.error', { error: err.message }));
    }
});

bot.command('ask', (ctx) => {
    const parts = ctx.message.text.split(' ');
    parts.shift();
    const query = parts.join(' ').trim();
    
    if (!query) return ctx.reply(t('ask.empty'));
    
    (async () => {
        try {
            const targetId = await sendViaCDP(query, CDP_PORT);
            setReaction(ctx, REACTION.THINKING);

            // Wait briefly for message to render in DOM before anchoring state
            await new Promise(r => setTimeout(r, 1500));
            await snapshotChatState(CDP_PORT, targetId).catch(() => {});
            
            if (global.__taskWatcher) global.__taskWatcher.setBusy(true);
            try {
                const isDone = await waitForAgentResponse(CDP_PORT, 450000, createProgressHandler(ctx));
                if (isDone) {
                    let _latestRes = await getFullLatestResponse(CDP_PORT);
                    let text = typeof _latestRes === 'string' ? _latestRes : _latestRes.text;
                    let buttons = typeof _latestRes === 'string' ? null : _latestRes.buttons;
                    
                    text = stripQueryFromResponse(text, query);
                    if (!text) text = t('ask.done_empty');
                    setReaction(ctx, null);
                    const header = await getChatHeader(null, t('ask.done'));
                    await sendLongMessage(ctx, text, header, buttons);
                } else {
                    await ctx.reply(t('ask.timeout'));
                }
            } finally {
                if (global.__taskWatcher) global.__taskWatcher.setBusy(false);
            }
        } catch (err) {
            setReaction(ctx, null);
            ctx.reply(t('ask.send_error', { error: err.message })).catch(() => {});
        }
    })();
});


bot.command('cmd', async (ctx) => {
    const cmdStr = ctx.message.text.split(' ').slice(1).join(' ');
    if (!cmdStr) {
        return ctx.reply(t('cmd.empty'));
    }
    
    ctx.reply(t('cmd.running', { cmdStr }), { parse_mode: 'MarkdownV2' });
    
    exec(cmdStr, { timeout: 60000, maxBuffer: 1024 * 1024 * 5 }, async (error, stdout, stderr) => {
        let output = "";
        if (stdout) output += `[STDOUT]\n${stdout}\n`;
        if (stderr) output += `[STDERR]\n${stderr}\n`;
        if (error) output += `[ERROR]\n${error.message}\n`;
        
        if (!output) output = t('cmd.no_output');
        
        await sendLongMessage(ctx, output, t('cmd.output_title'));
    });
});

bot.command('stop', async (ctx) => {
    if (currentEngine === 'claude') {
        const cancelled = cancelSession(String(ctx.chat.id));
        return ctx.reply(cancelled ? '⏹ Claude request cancelled.' : 'ℹ️ Nothing running.');
    }
    try {
        setReaction(ctx, REACTION.THINKING);
        const stopped = await stopAgent(CDP_PORT);
        if (stopped) {
            ctx.reply(t('stop.stopped'));
        } else {
            ctx.reply(t('stop.already_stopped'));
        }
    } catch(e) {
        ctx.reply(t('stop.error', { error: e.message }));
    }
});

// ===== ENGINE SWITCH =====
const handleEngine = async (ctx) => {
    ctx.reply('🔀 <b>Chọn Engine:</b>', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
            [Markup.button.callback(
                (currentEngine === 'antigravity' ? '👉 ' : '') + 'Antigravity (CDP)',
                'engine_antigravity'
            )],
            [Markup.button.callback(
                (currentEngine === 'claude' ? '👉 ' : '') + 'Claude Code (CLI)',
                'engine_claude'
            )]
        ])
    });
};
bot.command('engine', handleEngine);
bot.hears(/^🔀/i, handleEngine);

bot.action('engine_antigravity', async (ctx) => {
    currentEngine = 'antigravity';
    saveEngine('antigravity');
    ctx.answerCbQuery('Switched to Antigravity');
    await sendMainMenu(ctx, '🔀 Engine: <b>Antigravity (CDP)</b> ✅');
});

bot.action('engine_claude', async (ctx) => {
    currentEngine = 'claude';
    saveEngine('claude');
    ctx.answerCbQuery('Switched to Claude Code');
    await sendMainMenu(ctx, '🔀 Engine: <b>Claude Code (CLI)</b> ✅');
});

// ===== CLAUDE CODE QUERY HANDLER =====
async function handleClaudeQuery(ctx, query, explicitSessionId = null) {
    const chatId = String(ctx.chat.id);
    if (isSessionActive(chatId)) {
        return ctx.reply('⏳ Claude đang xử lý. /stop để huỷ.');
    }

    setReaction(ctx, REACTION.THINKING);
    const typingInterval = setInterval(() => ctx.sendChatAction('typing').catch(() => {}), 4000);
    let statusMsg = await ctx.reply('⏳ Claude đang xử lý...', { parse_mode: 'HTML' });
    let lastStatus = '';
    let toolCount = 0;

    try {
        // Auto-resume latest session if none set
        let sessionId = explicitSessionId || getLastSessionId(chatId);
        if (!sessionId) {
            const latest = getLatestSessionId(CLAUDE_WORK_DIR);
            if (latest) { sessionId = latest; setActiveSession(chatId, latest); }
        }

        const result = await sendToClaude(query, {
            chatId,
            workDir: CLAUDE_WORK_DIR,
            skipPermissions: CLAUDE_SKIP_PERMS,
            resumeSessionId: sessionId,
            model: typeof currentClaudeModel !== 'undefined' ? currentClaudeModel : undefined,
            onEvent: (event) => {
                let newStatus = null;
                if (event.type === 'system' && event.subtype === 'init') {
                    newStatus = '🔌 Connected. Thinking...';
                } else if (event.type === 'assistant' && event.message?.content) {
                    for (const block of event.message.content) {
                        if (block.type === 'tool_use') {
                            toolCount++;
                            const toolName = block.name || 'tool';
                            const input = block.input || {};
                            let detail = '';
                            if (toolName === 'Bash' && input.command) detail = `: ${input.command.slice(0, 40)}`;
                            else if (input.file_path) detail = `: ${path.basename(input.file_path)}`;
                            newStatus = `🛠 [${toolCount}] ${toolName}${detail}`;
                        }
                    }
                }
                if (newStatus && newStatus !== lastStatus) {
                    lastStatus = newStatus;
                    ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, newStatus)
                        .catch(() => {});
                }
            }
        });

        clearInterval(typingInterval);
        ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
        setReaction(ctx, null);

        if (!result.text) return ctx.reply('⚠️ Response rỗng.');

        const footer = `\n\n⏱ ${(result.duration / 1000).toFixed(1)}s` +
            (result.toolsUsed.length ? ` | 🛠 ${result.toolsUsed.join(', ')}` : '');

        const sentIds = await sendLongMessage(ctx, result.text + footer, '🤖 Claude Code');
        if (sentIds && sentIds.length > 0 && result.sessionId) {
            sentIds.forEach(id => messageTargetMap.set(id, { claudeSessionId: result.sessionId }));
            saveMessageTargetMap(messageTargetMap);
        }
    } catch (err) {
        clearInterval(typingInterval);
        ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
        setReaction(ctx, null);
        console.error(`❌ Claude [${chatId}]:`, err.message);
        ctx.reply(`❌ ${err.message}`);
    }
}

// ===== CLAUDE SESSION PICKER =====
const handleSession = async (ctx) => {
    if (typeof currentEngine !== 'undefined' && currentEngine === 'antigravity') return;
    if (currentEngine !== 'claude') {
        return ctx.reply('ℹ️ Session chỉ dùng cho Claude Code engine.\nDùng /engine để chuyển.');
    }
    const chatId = String(ctx.chat.id);
    const sessionsList = listSessions(CLAUDE_WORK_DIR, 5);
    const currentSid = getLastSessionId(chatId);

    const buttons = sessionsList.map(s => {
        const prefix = s.sessionId === currentSid ? '👉 ' : '';
        const label = `${prefix}${s.title} (${formatRelativeTime(s.mtime)})`;
        return [Markup.button.callback(label, `cs_${s.sessionId}`)];
    });
    buttons.push([
        Markup.button.callback('🆕 New', 'cs_new'),
        Markup.button.callback('🔄 Refresh', 'cs_refresh')
    ]);

    ctx.reply(`📋 <b>Claude Sessions</b>\nCWD: <code>${CLAUDE_WORK_DIR}</code>`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(buttons)
    });
};
bot.command('session', handleSession);
bot.hears(/^📋/i, handleSession);

bot.action(/^cs_(.+)$/, (ctx) => {
    const chatId = String(ctx.chat.id);
    const val = ctx.match[1];
    if (val === 'new') {
        resetSession(chatId);
        ctx.answerCbQuery('New session');
        ctx.editMessageText('📋 Session mới (sẽ tạo khi gửi tin nhắn).', { parse_mode: 'HTML' }).catch(() => {});
    } else if (val === 'refresh') {
        ctx.answerCbQuery('Refreshed');
        handleSession(ctx).catch(() => {});
    } else {
        setActiveSession(chatId, val);
        ctx.answerCbQuery(`Session: ${val.slice(0, 8)}`);
        ctx.editMessageText(`📋 Đã chọn session: <code>${val}</code>`, { parse_mode: 'HTML' }).catch(() => {});
    }
});

// ===== IDE NATIVE COMMANDS =====

bot.command('goal', async (ctx) => {
    const parts = ctx.message.text.split(' ');
    parts.shift();
    const goalText = parts.join(' ').trim();
    
    if (!goalText) return ctx.reply(t('native_cmd.goal_empty'));
    
    setReaction(ctx, REACTION.THINKING);
    try {
        await sendViaCDP('/goal ' + goalText, CDP_PORT);
        setReaction(ctx, null);
        await ctx.reply(t('native_cmd.goal_started'));
    } catch (err) {
        setReaction(ctx, null);
        ctx.reply(t('native_cmd.error', { error: err.message }));
    }
});

bot.command('plan', async (ctx) => {
    const parts = ctx.message.text.split(' ');
    parts.shift();
    const planText = parts.join(' ').trim();
    
    if (!planText) return ctx.reply(t('native_cmd.plan_empty'));
    
    setReaction(ctx, REACTION.THINKING);
    try {
        await sendViaCDP('/plan ' + planText, CDP_PORT);
        setReaction(ctx, null);
        await ctx.reply(t('native_cmd.plan_started'));
    } catch (err) {
        setReaction(ctx, null);
        ctx.reply(t('native_cmd.error', { error: err.message }));
    }
});

bot.command('schedule_task', async (ctx) => {
    const parts = ctx.message.text.split(' ');
    parts.shift();
    const scheduleText = parts.join(' ').trim();
    
    if (!scheduleText) return ctx.reply(t('native_cmd.schedule_empty'));
    
    setReaction(ctx, REACTION.THINKING);
    try {
        // Send as /schedule to IDE — the IDE recognizes this native command
        await sendViaCDP('/schedule ' + scheduleText, CDP_PORT);
        setReaction(ctx, null);
        await ctx.reply(t('native_cmd.schedule_started'));
    } catch (err) {
        setReaction(ctx, null);
        ctx.reply(t('native_cmd.error', { error: err.message }));
    }
});

// ===== CRONCREW SCHEDULE MANAGEMENT =====

bot.command('schedule_setup', async (ctx) => {
    if (!scheduleClient) return ctx.reply(t('schedule.not_configured'), { parse_mode: 'HTML' });
    const parts = ctx.message.text.split(' ');
    parts.shift();
    if (parts.length < 2) return ctx.reply(t('schedule.setup_usage'), { parse_mode: 'HTML' });
    
    const serverUrl = parts[0];
    const licenseKey = parts.slice(1).join(' ').trim();
    
    setReaction(ctx, REACTION.THINKING);
    try {
        const result = await scheduleClient.setup(serverUrl, licenseKey);
        setReaction(ctx, REACTION.SUCCESS);
        ctx.reply(t('schedule.setup_success', { tier: result.tier, url: serverUrl }), { parse_mode: 'HTML' });
    } catch (err) {
        setReaction(ctx, null);
        ctx.reply(t('schedule.setup_error', { error: err.message }), { parse_mode: 'HTML' });
    }
});

bot.command('schedule_status', async (ctx) => {
    if (!scheduleClient || !scheduleClient.isConfigured()) return ctx.reply(t('schedule.not_configured'), { parse_mode: 'HTML' });
    
    setReaction(ctx, REACTION.THINKING);
    try {
        const [status, usage] = await Promise.all([
            scheduleClient.getStatus(),
            scheduleClient.getUsage()
        ]);
        
        let msg = t('schedule.status_title');
        msg += t('schedule.status_tier', { tier: status.tier });
        msg += t('schedule.status_license', { status: status.status });
        msg += t('schedule.status_usage', { today: usage.executionsToday });
        msg += t('schedule.status_schedules', { count: usage.activeSchedules });
        msg += t('schedule.status_changes', { used: status.changesUsed, max: status.changesMax });
        if (status.expiresAt) msg += t('schedule.status_expires', { date: status.expiresAt });
        
        setReaction(ctx, null);
        ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (err) {
        setReaction(ctx, null);
        ctx.reply(t('schedule.error', { error: err.message }), { parse_mode: 'HTML' });
    }
});

bot.command('schedule_list', async (ctx) => {
    if (!scheduleClient || !scheduleClient.isConfigured()) return ctx.reply(t('schedule.not_configured'), { parse_mode: 'HTML' });
    
    setReaction(ctx, REACTION.THINKING);
    try {
        const schedules = await scheduleClient.listSchedules();
        setReaction(ctx, null);
        
        if (!schedules || schedules.length === 0) {
            return ctx.reply(t('schedule.list_empty'), { parse_mode: 'HTML' });
        }
        
        let msg = t('schedule.list_title');
        const buttons = [];
        
        for (const s of schedules) {
            const icon = s.status === 'active' ? '🟢' : '⏸️';
            const lastResult = s.last_result || '—';
            msg += t('schedule.list_item', {
                icon, name: s.name, cron: s.cron_expression,
                workspace: s.workspace, runCount: s.run_count, lastResult
            });
            
            const row = [];
            if (s.status === 'active') {
                row.push(Markup.button.callback(t('schedule.btn_run'), `sch_run_${s.id}`));
                row.push(Markup.button.callback(t('schedule.btn_pause'), `sch_pause_${s.id}`));
            } else {
                row.push(Markup.button.callback(t('schedule.btn_resume'), `sch_resume_${s.id}`));
            }
            row.push(Markup.button.callback(t('schedule.btn_delete'), `sch_del_${s.id}`));
            buttons.push(row);
        }
        
        ctx.reply(msg, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    } catch (err) {
        setReaction(ctx, null);
        ctx.reply(t('schedule.error', { error: err.message }), { parse_mode: 'HTML' });
    }
});

bot.command('schedule_add', async (ctx) => {
    if (!scheduleClient || !scheduleClient.isConfigured()) return ctx.reply(t('schedule.not_configured'), { parse_mode: 'HTML' });
    
    const parts = ctx.message.text.split(' ');
    parts.shift();
    const raw = parts.join(' ').trim();
    
    if (!raw || !raw.includes('|')) return ctx.reply(t('schedule.add_usage'), { parse_mode: 'HTML' });
    
    const segments = raw.split('|').map(s => s.trim());
    if (segments.length < 4) return ctx.reply(t('schedule.add_usage'), { parse_mode: 'HTML' });
    
    const [name, cronExpr, workspace, ...promptParts] = segments;
    const prompt = promptParts.join('|').trim();
    
    setReaction(ctx, REACTION.THINKING);
    try {
        const schedule = await scheduleClient.createSchedule({
            name, cron_expression: cronExpr, workspace, prompt
        });
        setReaction(ctx, REACTION.SUCCESS);
        ctx.reply(t('schedule.add_success', {
            name: schedule.name, cron: schedule.cron_expression,
            workspace: schedule.workspace, model: schedule.model
        }), { parse_mode: 'HTML' });
    } catch (err) {
        setReaction(ctx, null);
        ctx.reply(t('schedule.add_error', { error: err.message }), { parse_mode: 'HTML' });
    }
});

bot.command('schedule_del', async (ctx) => {
    if (!scheduleClient || !scheduleClient.isConfigured()) return ctx.reply(t('schedule.not_configured'), { parse_mode: 'HTML' });
    
    const parts = ctx.message.text.split(' ');
    parts.shift();
    const scheduleId = parts.join(' ').trim();
    
    if (!scheduleId) return ctx.reply(t('schedule.delete_usage'), { parse_mode: 'HTML' });
    
    setReaction(ctx, REACTION.THINKING);
    try {
        await scheduleClient.deleteSchedule(scheduleId);
        setReaction(ctx, REACTION.SUCCESS);
        ctx.reply(t('schedule.delete_success'), { parse_mode: 'HTML' });
    } catch (err) {
        setReaction(ctx, null);
        ctx.reply(t('schedule.delete_error', { error: err.message }), { parse_mode: 'HTML' });
    }
});

// Schedule inline button actions
bot.action(/^sch_run_(.+)$/, async (ctx) => {
    if (!scheduleClient) return ctx.answerCbQuery('Schedule not available', { show_alert: true });
    const scheduleId = ctx.match[1];
    ctx.answerCbQuery('Running...');
    try {
        const result = await scheduleClient.executeSchedule(scheduleId);
        
        // Actually send the prompt to the IDE agent
        const targetId = getPreferredTargetId() || null;
        await sendViaCDP(result.prompt, CDP_PORT, targetId);
        
        ctx.reply(t('schedule.run_success', {
            workspace: result.workspace, model: result.model
        }), { parse_mode: 'HTML' });
    } catch (err) {
        ctx.reply(t('schedule.run_error', { error: err.message }), { parse_mode: 'HTML' });
    }
});

bot.action(/^sch_pause_(.+)$/, async (ctx) => {
    if (!scheduleClient) return ctx.answerCbQuery('Schedule not available', { show_alert: true });
    const scheduleId = ctx.match[1];
    ctx.answerCbQuery('Pausing...');
    try {
        const result = await scheduleClient.pauseSchedule(scheduleId);
        ctx.reply(t('schedule.pause_success', { name: result.name || scheduleId }), { parse_mode: 'HTML' });
    } catch (err) {
        ctx.reply(t('schedule.error', { error: err.message }), { parse_mode: 'HTML' });
    }
});

bot.action(/^sch_resume_(.+)$/, async (ctx) => {
    if (!scheduleClient) return ctx.answerCbQuery('Schedule not available', { show_alert: true });
    const scheduleId = ctx.match[1];
    ctx.answerCbQuery('Resuming...');
    try {
        const result = await scheduleClient.resumeSchedule(scheduleId);
        ctx.reply(t('schedule.resume_success', { name: result.name || scheduleId }), { parse_mode: 'HTML' });
    } catch (err) {
        ctx.reply(t('schedule.error', { error: err.message }), { parse_mode: 'HTML' });
    }
});

bot.action(/^sch_del_(.+)$/, async (ctx) => {
    if (!scheduleClient) return ctx.answerCbQuery('Schedule not available', { show_alert: true });
    const scheduleId = ctx.match[1];
    ctx.answerCbQuery('Deleting...');
    try {
        await scheduleClient.deleteSchedule(scheduleId);
        ctx.reply(t('schedule.delete_success'), { parse_mode: 'HTML' });
    } catch (err) {
        ctx.reply(t('schedule.error', { error: err.message }), { parse_mode: 'HTML' });
    }
});

// Helper to get all available skills from ~/.gemini/config/skills
function getAvailableSkills() {
    const skillsDir = path.join(os.homedir(), '.gemini', 'config', 'skills');
    if (!fs.existsSync(skillsDir)) return [];
    
    try {
        const items = fs.readdirSync(skillsDir, { withFileTypes: true });
        return items
            .filter(item => item.isDirectory())
            .map(item => item.name)
            .filter(name => {
                // Ensure SKILL.md exists in the folder
                return fs.existsSync(path.join(skillsDir, name, 'SKILL.md'));
            });
    } catch (e) {
        console.error('Error reading skills directory:', e.message);
        return [];
    }
}

async function handleListSkills(ctx, pageIndex = 0) {
    if (typeof currentEngine !== 'undefined' && currentEngine === 'claude') {
        return ctx.reply(t('feature.claude_unsupported') || '❌ This feature is currently only available in Antigravity mode.');
    }
    const skills = getAvailableSkills();
    if (skills.length === 0) {
        return ctx.reply(t('skills.empty') || 'No skills found.');
    }
    
    const itemsPerPage = 8;
    const totalPages = Math.ceil(skills.length / itemsPerPage);
    if (pageIndex < 0) pageIndex = 0;
    if (pageIndex >= totalPages) pageIndex = totalPages - 1;
    
    const startIndex = pageIndex * itemsPerPage;
    const pageSkills = skills.slice(startIndex, startIndex + itemsPerPage);
    
    let msg = t('skills.list_title', { page: pageIndex + 1, totalPages }) || `🧩 <b>Available Skills (Page {page}/{totalPages}):</b>\n\nSelect a skill below to see its details and quick call template:`;
    msg = msg.replace('{page}', pageIndex + 1).replace('{totalPages}', totalPages);

    // Build buttons grid (2 columns)
    const keyboardButtons = [];
    for (let i = 0; i < pageSkills.length; i += 2) {
        const row = [];
        row.push(Markup.button.callback(pageSkills[i], `skill_info:${pageSkills[i]}:${pageIndex}`));
        if (i + 1 < pageSkills.length) {
            row.push(Markup.button.callback(pageSkills[i + 1], `skill_info:${pageSkills[i + 1]}:${pageIndex}`));
        }
        keyboardButtons.push(row);
    }
    
    // Pagination row
    const navRow = [];
    if (pageIndex > 0) {
        navRow.push(Markup.button.callback('◀️ Prev', `skill_page:${pageIndex - 1}`));
    }
    if (pageIndex < totalPages - 1) {
        navRow.push(Markup.button.callback('Next ▶️', `skill_page:${pageIndex + 1}`));
    }
    if (navRow.length > 0) {
        keyboardButtons.push(navRow);
    }
    
    const replyMarkup = Markup.inlineKeyboard(keyboardButtons);
    
    if (ctx.callbackQuery) {
        await ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: replyMarkup.reply_markup }).catch(e => {
            if (!e.message.includes('message is not modified')) {
                ctx.reply(msg, { parse_mode: 'HTML', reply_markup: replyMarkup.reply_markup });
            }
        });
    } else {
        await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: replyMarkup.reply_markup });
    }
}

async function handleSkillInfo(ctx, skillName, returnPage) {
    const skillsDir = path.join(os.homedir(), '.gemini', 'config', 'skills');
    const skillMdPath = path.join(skillsDir, skillName, 'SKILL.md');
    
    let description = '';
    if (fs.existsSync(skillMdPath)) {
        try {
            const content = fs.readFileSync(skillMdPath, 'utf-8');
            // Try parsing frontmatter
            const match = content.match(/^---([\s\S]*?)---/);
            if (match) {
                const yaml = match[1];
                const descMatch = yaml.match(/description:\s*([\s\S]+?)(?=\n\w+:|$)/);
                if (descMatch) {
                    description = descMatch[1].trim().replace(/^['"]|['"]$/g, '');
                }
            }
            if (!description) {
                // Take first few lines after frontmatter
                const lines = content.replace(/^---[\s\S]*?---/, '').trim().split('\n');
                description = lines.slice(0, 5).join('\n').trim();
            }
        } catch (e) {
            description = 'Failed to load description.';
        }
    } else {
        description = 'SKILL.md not found.';
    }
    
    let msg = `🧩 <b>Skill:</b> <code>${skillName}</code>\n\n`;
    if (description) {
        msg += `📝 <b>Description:</b>\n<i>${description}</i>\n\n`;
    }
    
    let syntaxTemplate = t('skills.syntax') || "💡 <b>Quick call syntax:</b>\n<code>!{name} [arguments]</code>\n\nTap the command above to copy it, edit on your chat bar, and send!";
    syntaxTemplate = syntaxTemplate.replace(/\{name\}/g, skillName);
    msg += syntaxTemplate;
    
    const buttons = [
        [
            Markup.button.callback(t('skills.back_btn') || '◀️ Back to Skills', `skill_page:${returnPage}`),
            Markup.button.switchToCurrentChat(t('skills.run_btn') || '▶️ Run Skill', `!${skillName} `)
        ]
    ];
    
    const replyMarkup = Markup.inlineKeyboard(buttons);
    
    await ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: replyMarkup.reply_markup }).catch(e => {
        if (!e.message.includes('message is not modified')) {
            ctx.reply(msg, { parse_mode: 'HTML', reply_markup: replyMarkup.reply_markup });
        }
    });
}

// Register skill commands & handlers
bot.hears(/^🛠️/i, (ctx) => handleListSkills(ctx, 0));
bot.command('skills', (ctx) => handleListSkills(ctx, 0));
bot.command('skill', (ctx) => handleListSkills(ctx, 0));

bot.action(/^skill_page:(\d+)$/, async (ctx) => {
    const page = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery().catch(()=>{});
    await handleListSkills(ctx, page);
});

bot.action(/^skill_info:(.+):(\d+)$/, async (ctx) => {
    const skillName = ctx.match[1];
    const page = parseInt(ctx.match[2], 10);
    await ctx.answerCbQuery().catch(()=>{});
    await handleSkillInfo(ctx, skillName, page);
});

bot.command('new', async (ctx) => {
    console.log('[/new] Command triggered');
    try {
        const success = await triggerNewChat(CDP_PORT);
        console.log('[/new] triggerNewChat result:', success);
        if (success) {
            ctx.reply(t('new_chat.opened'));
            setTimeout(() => {
                const defaultModel = process.env.DEFAULT_MODEL || 'Gemini 3.1 Pro (High)';
                selectModel(CDP_PORT, defaultModel).catch(()=>{});
            }, 1500);
        } else {
            ctx.reply(t('new_chat.not_found'));
        }
    } catch(e) {
        console.log('[/new] Error:', e.message);
        ctx.reply(t('new_chat.error', { error: e.message }));
    }
});

bot.command('agents', async (ctx) => {
    if (typeof currentEngine !== 'undefined' && currentEngine === 'claude') {
        return ctx.reply(t('feature.claude_unsupported') || '❌ This feature is currently only available in Antigravity mode.');
    }
    const parts = ctx.message.text.split(' ');
    const num = parseInt(parts[1], 10);
    
    if (!isNaN(num)) {
        if (num > 0 && num <= cachedAgentThreads.length) {
            const thread = cachedAgentThreads[num - 1];
            const success = await switchAgentThread(CDP_PORT, thread.name);
            if (!success) {
                ctx.reply(t('agents.not_found') || '❌ Thread could not be selected.');
            } else {
                setPreferredWindow(null);
                if (thread.workspace) setActiveWorkspace(thread.workspace);
                // Update lastResolvedThreadId so /latest reads from this thread
                await snapshotChatState(CDP_PORT, success).catch(() => {});
                await sendMainMenu(ctx, t('agents.switched_plain', { name: thread.name }), thread.name, thread.workspace);
            }
        } else {
            ctx.reply(t('agents.invalid_number') || '❌ Invalid thread number.');
        }
        return;
    }
    
    try {
        const workspaces = await listAgentThreads(CDP_PORT);
        if (workspaces.length === 0) {
            return ctx.reply(t('agents.no_recent') || 'ℹ️ No recent active threads found.');
        }
        
        cachedAgentThreads = [];
        let msg = t('agents.list_title') || '📂 <b>Recent Chat Threads:</b>\\n\\n';
        let index = 1;
        
        for (const ws of workspaces) {
            const recentThreads = ws.threads.filter(th => {
                // Skip the "Show N more..." load-more button
                if (/^show\s+\d+\s+more/i.test(th.name)) return false;
                return true;
            });
            
            if (recentThreads.length > 0) {
                msg += `<b>📁 ${ws.workspace}</b>\n`;
                for (const th of recentThreads) {
                    cachedAgentThreads.push({ ...th, workspace: ws.workspace });
                    msg += `  /agents_${index} - ${th.name} <i>(${th.time})</i>\n`;
                    index++;
                }
                msg += '\n';
            }
        }
        
        if (cachedAgentThreads.length === 0) {
            return ctx.reply(t('agents.no_recent') || 'ℹ️ No recent active threads found.');
        }
        
        ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (e) {
        ctx.reply((t('agents.error') || '❌ Error: ') + e.message);
    }
});

bot.hears(/^\/agents_(\d+)$/, async (ctx) => {
    const num = parseInt(ctx.match[1], 10);
    if (num > 0 && num <= cachedAgentThreads.length) {
        const thread = cachedAgentThreads[num - 1];
        const targetId = await switchAgentThread(CDP_PORT, thread.name, thread.workspace);
        if (!targetId) {
            ctx.reply(t('agents.not_found') || '❌ Thread could not be selected.');
        } else {
            // Reset window preference and let it auto-detect the workspace
            setPreferredWindow(null);
            if (thread.workspace) {
                setActiveWorkspace(thread.workspace);
            }
            // Update lastResolvedThreadId so /latest reads from this thread
            await snapshotChatState(CDP_PORT, targetId, thread.name).catch(() => {});
            // Menüyü yenile — buton yeni ajan ismini göstersin
            await sendMainMenu(ctx, t('agents.switched_plain', { name: thread.name }), thread.name, thread.workspace);
        }
    } else {
        ctx.reply(t('agents.invalid_number') || '❌ Invalid thread number.');
    }
});

const handleArtifacts = async (ctx) => {
    if (typeof currentEngine !== 'undefined' && currentEngine === 'claude') {
        return ctx.reply(t('feature.claude_unsupported') || '❌ This feature is currently only available in Antigravity mode.');
    }
    try {
        const appDataName = (process.env.ANTIGRAVITY_PREFERRED_APP || 'agent') === 'ide' ? 'antigravity-ide' : 'antigravity';
        const brainPath = path.join(os.homedir(), '.gemini', appDataName, 'brain');
        
        // Helper to check if a file should be listed as an artifact
        const ARTIFACT_EXTENSIONS = ['.md', '.png', '.jpg', '.jpeg', '.webp', '.mp4', '.mov', '.gif', '.pdf', '.txt', '.json', '.csv', '.html'];
        const isArtifactFile = (name) => {
            if (name.includes('.metadata.json') || name.includes('.resolved') || name.startsWith('.sys') || name.startsWith('.')) return false;
            return ARTIFACT_EXTENSIONS.some(ext => name.endsWith(ext));
        };
        const getMtime = (filePath) => {
            try { return fs.statSync(filePath).mtimeMs; } catch (_) { return 0; }
        };

        // Try to get the active thread info for workspace filtering
        let threadInfo = null;
        try { threadInfo = await getActiveThreadInfo(CDP_PORT, getPreferredTargetId()); } catch (_) {}
        const workspaceName = threadInfo?.workspace?.split(' - ')?.[0]?.trim()?.toLowerCase() || null;
        
        // Strategy: Try known thread ID first, then scan all conversations
        let conversationId = getLastResolvedThreadId();
        let conversationDir = conversationId ? path.join(brainPath, conversationId) : null;
        
        // Quick check: does this conversation actually have RECENT artifacts?
        // We also verify the conversation is recent (active within last 2 hours)
        // to avoid showing stale artifacts from old conversations.
        let hasArtifacts = false;
        if (conversationDir && fs.existsSync(conversationDir)) {
            const items = fs.readdirSync(conversationDir, { withFileTypes: true });
            const hasFiles = items.some(i => !i.isDirectory() && isArtifactFile(i.name)) || 
                           fs.existsSync(path.join(conversationDir, 'artifacts'));
            
            if (hasFiles) {
                // Check if this conversation is still recent — avoid showing artifacts
                // from a weeks-old conversation just because lastResolvedThreadId points to it
                const tp = path.join(conversationDir, '.system_generated', 'logs', 'transcript.jsonl');
                let isRecent = false;
                try {
                    if (fs.existsSync(tp)) {
                        const mtime = fs.statSync(tp).mtimeMs;
                        isRecent = (Date.now() - mtime) < 2 * 60 * 60 * 1000; // 2 hours
                    }
                } catch (_) {}
                
                if (isRecent) {
                    hasArtifacts = true;
                } else {
                    console.log(`[handleArtifacts] lastResolvedThreadId ${conversationId?.substring(0, 8)} has artifacts but is stale — scanning brain...`);
                }
            }
        }
        
        // If no artifacts found via lastResolvedThreadId, scan ALL conversations
        // filtered by workspace name, sorted by most recently modified
        if (!hasArtifacts && fs.existsSync(brainPath)) {
            console.log(`[handleArtifacts] lastResolvedThreadId ${conversationId?.substring(0, 8) || 'null'} has no artifacts — scanning brain...`);
            const normalize = (s) => (s || '').toLowerCase().replace(/[-_]/g, ' ');
            const dirs = fs.readdirSync(brainPath, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => {
                    const dir = path.join(brainPath, d.name);
                    const tp = path.join(dir, '.system_generated', 'logs', 'transcript.jsonl');
                    let mtime = 0;
                    try { if (fs.existsSync(tp)) mtime = fs.statSync(tp).mtimeMs; } catch (_) {}
                    return { name: d.name, dir, mtime };
                })
                .filter(d => d.mtime > 0)
                .sort((a, b) => b.mtime - a.mtime);
            
            for (const dir of dirs) {
                // Check if this conversation has artifacts
                const items = fs.readdirSync(dir.dir, { withFileTypes: true });
                const dirHasArtifacts = items.some(i => !i.isDirectory() && isArtifactFile(i.name)) ||
                                        fs.existsSync(path.join(dir.dir, 'artifacts'));
                if (!dirHasArtifacts) continue;
                
                // If we have a workspace filter, check that the transcript mentions this workspace
                if (workspaceName) {
                    const tp = path.join(dir.dir, '.system_generated', 'logs', 'transcript.jsonl');
                    try {
                        const head = fs.readFileSync(tp, 'utf8').substring(0, 5000);
                        if (!normalize(head).includes(normalize(workspaceName))) continue;
                    } catch (_) { continue; }
                }
                
                conversationId = dir.name;
                conversationDir = dir.dir;
                console.log(`[handleArtifacts] Found artifacts in conversation ${dir.name.substring(0, 8)} (workspace: ${workspaceName || 'any'})`);
                break;
            }
        }
        
        if (!conversationDir || !fs.existsSync(conversationDir)) {
            return ctx.reply(t('artifacts.no_active_thread') || '⚠️ No active thread found. Please select a thread in the IDE first.');
        }

        cachedArtifacts = [];

        // 1. Scan artifacts/ subdirectory
        const artifactsSubDir = path.join(conversationDir, 'artifacts');
        if (fs.existsSync(artifactsSubDir)) {
            const items = fs.readdirSync(artifactsSubDir, { withFileTypes: true });
            for (const item of items) {
                if (item.isDirectory()) continue;
                if (isArtifactFile(item.name)) {
                    const filePath = path.join(artifactsSubDir, item.name);
                    cachedArtifacts.push({ name: item.name, path: filePath, mtime: getMtime(filePath) });
                }
            }
        }

        // 2. Scan conversation root
        const rootItems = fs.readdirSync(conversationDir, { withFileTypes: true });
        for (const item of rootItems) {
            if (item.isDirectory()) continue;
            if (isArtifactFile(item.name)) {
                const filePath = path.join(conversationDir, item.name);
                cachedArtifacts.push({ name: item.name, path: filePath, mtime: getMtime(filePath) });
            }
        }

        // 3. Scan scratch/ subdirectory for temporary files
        const scratchDir = path.join(conversationDir, 'scratch');
        if (fs.existsSync(scratchDir)) {
            const scratchItems = fs.readdirSync(scratchDir, { withFileTypes: true });
            for (const item of scratchItems) {
                if (item.isDirectory()) continue;
                const filePath = path.join(scratchDir, item.name);
                cachedArtifacts.push({ name: `scratch/${item.name}`, path: filePath, mtime: getMtime(filePath) });
            }
        }

        // 4. Scan browser/ subdirectory for browser recordings
        const browserDir = path.join(conversationDir, 'browser');
        if (fs.existsSync(browserDir)) {
            const browserItems = fs.readdirSync(browserDir, { withFileTypes: true });
            for (const item of browserItems) {
                if (item.isDirectory()) continue;
                if (isArtifactFile(item.name)) {
                    const filePath = path.join(browserDir, item.name);
                    cachedArtifacts.push({ name: `🌐 ${item.name}`, path: filePath, mtime: getMtime(filePath) });
                }
            }
        }

        if (cachedArtifacts.length === 0) {
            return ctx.reply(t('artifacts.no_artifacts') || 'ℹ️ No artifacts found for the current thread.');
        }

        // Sort by modification time, newest first
        cachedArtifacts.sort((a, b) => b.mtime - a.mtime);

        let msg = t('artifacts.list_title') || '📎 <b>Artifacts for Current Thread:</b>\\n\\n';
        for (let i = 0; i < cachedArtifacts.length; i++) {
            const filename = cachedArtifacts[i].name;
            let displayName = filename;
            if (filename.startsWith('media__')) {
                const match = filename.match(/media__(\d+)\.\w+/);
                if (match) {
                    const date = new Date(parseInt(match[1], 10));
                    const today = new Date();
                    const yesterday = new Date(today);
                    yesterday.setDate(yesterday.getDate() - 1);
                    
                    let dateStr = '';
                    if (date.toDateString() === today.toDateString()) dateStr = 'Today';
                    else if (date.toDateString() === yesterday.toDateString()) dateStr = 'Yesterday';
                    else dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    
                    const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
                    displayName = `Media (${dateStr} ${timeStr})`;
                }
            } else {
                displayName = filename.replace(/\.[^/.]+$/, "").replace(/_/g, ' ').split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            }
            msg += `/artifact_${i + 1} - ${displayName}\n`;
        }
        
        ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (e) {
        ctx.reply((t('artifacts.error') || '❌ Error reading artifact: ') + e.message);
    }
};

bot.command('artifacts', handleArtifacts);
bot.hears(/^📦/i, handleArtifacts);

bot.hears(/^\/artifact_(\d+)$/, async (ctx) => {
    const num = parseInt(ctx.match[1], 10);
    if (num > 0 && num <= cachedArtifacts.length) {
        const artifact = cachedArtifacts[num - 1];
        ctx.reply((t('artifacts.sending', { name: artifact.name }) || `📤 Sending artifact: <b>${artifact.name}</b>...`), { parse_mode: 'HTML' });
        
        const ext = path.extname(artifact.name).toLowerCase();
        try {
            if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp') {
                await ctx.replyWithPhoto({ source: artifact.path });
            } else if (ext === '.mp4' || ext === '.mov') {
                await ctx.replyWithVideo({ source: artifact.path });
            } else if (ext === '.md') {
                const content = fs.readFileSync(artifact.path, 'utf8');
                await sendLongMessage(ctx, content);
            } else {
                await ctx.replyWithDocument({ source: artifact.path });
            }
        } catch (e) {
            ctx.reply((t('artifacts.error') || '❌ Error: ') + e.message);
        }
    } else {
        ctx.reply(t('artifacts.invalid_number') || '❌ Invalid artifact number.');
    }
});

const handleModel = async (ctx) => {
    if (typeof currentEngine !== 'undefined' && currentEngine === 'claude') {
        let modelName = '';
        if (ctx.message && ctx.message.text) {
            const parts = ctx.message.text.split(' ');
            if (parts[0].startsWith('/')) parts.shift();
            modelName = parts.join(' ').trim();
            if (modelName.startsWith('🧠') || modelName.startsWith('🤖') || modelName.toLowerCase().startsWith('model:')) modelName = '';
        }
        
        if (modelName) {
            currentClaudeModel = modelName;
            saveClaudeModel(modelName);
            ctx.reply(`✅ Đã đổi model Claude Code thành: <b>${modelName}</b>`, { parse_mode: 'HTML' });
            return;
        }

        const models = [
            { label: '⚡ claude-haiku-4-5 (nhanh, rẻ)', value: 'haiku' },
            { label: '🧠 claude-sonnet-4-6 (cân bằng)', value: 'sonnet' },
            { label: '🔥 claude-opus-4-8 (mạnh nhất)', value: 'opus' },
            { label: '🧠 claude-sonnet-4-6 (full ID)', value: 'claude-sonnet-4-6' },
            { label: '🔥 claude-opus-4-8 (full ID)', value: 'claude-opus-4-8' },
        ];

        const buttons = models.map(m => {
            const cbData = 'cmd_' + Buffer.from(m.value).toString('base64').slice(0, 58);
            return [{ text: `${m.label}${currentClaudeModel === m.value ? ' ✅' : ''}`, callback_data: cbData }];
        });
        
        ctx.reply('🧠 <b>Chọn Model cho Claude Code:</b>\nHoặc gõ <code>/model [tên_model]</code> để đổi sang model khác.', {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: buttons }
        });
        return;
    }

    let modelName = '';
    if (ctx.message && ctx.message.text) {
        const parts = ctx.message.text.split(' ');
        if (parts[0].startsWith('/')) parts.shift();
        modelName = parts.join(' ').trim();
        // Clear if it's from the button text
        if (modelName.startsWith('🧠') || modelName.startsWith('🤖') || modelName.toLowerCase().startsWith('model:')) modelName = '';
    }
    
    if (modelName) {
        try {
            setReaction(ctx, REACTION.THINKING);
            const success = await selectModel(CDP_PORT, modelName);
            if (success) ctx.reply(t('model.changed', { model: modelName }));
            else ctx.reply(t('model.not_found'));
        } catch(e) {
            ctx.reply(t('stop.error', { error: e.message }));
        }
        return;
    }
    let models = [];
    try {
        models = await getAvailableModels(CDP_PORT);
    } catch (e) {
        console.error('Failed to get dynamic models:', e.message);
    }

    if (!models || models.length === 0) {
        models = [
            'Gemini 3.5 Flash (Medium)',
            'Gemini 3.5 Flash (High)',
            'Gemini 3.5 Flash (Low)',
            'Gemini 3.1 Pro (High)',
            'Gemini 3.1 Pro (Low)',
            'Claude Sonnet 4.6 (Thinking)',
            'Claude Opus 4.6 (Thinking)',
            'GPT-OSS 120B (Medium)'
        ];
    }
    
    const buttons = models.map(m => {
        const cbData = 'md_' + Buffer.from(m).toString('base64').slice(0, 58);
        return [{ text: `🤖 ${m}`, callback_data: cbData }];
    });
    
    ctx.reply(t('model.select_prompt'), {
        reply_markup: { inline_keyboard: buttons }
    });
};
bot.command('model', handleModel);

bot.action(/^md_(.+)/, async (ctx) => {
    try {
        const modelName = Buffer.from(ctx.match[1], 'base64').toString('utf-8');
        ctx.answerCbQuery(modelName);
        const changingText = t('model.changing', { model: modelName });
        if (ctx.callbackQuery && ctx.callbackQuery.message) {
            await ctx.editMessageText(changingText).catch(()=>{});
        } else {
            await ctx.reply(changingText);
        }
        const success = await selectModel(CDP_PORT, modelName);
        if (success) await sendMainMenu(ctx, t('model.changed', { model: modelName }));
        else ctx.reply(t('model.select_failed'));
    } catch(e) {
        ctx.answerCbQuery(t('model.error'));
    }
});

bot.action(/^cmd_(.+)/, async (ctx) => {
    try {
        const modelName = Buffer.from(ctx.match[1], 'base64').toString('utf-8');
        ctx.answerCbQuery(modelName);
        currentClaudeModel = modelName;
        saveClaudeModel(modelName);
        await sendMainMenu(ctx, `🧠 Model Claude Code: <b>${modelName}</b> ✅`);
    } catch (e) {
        ctx.reply(`❌ ${e.message}`);
    }
});

// ===== AUTO-ACCEPT =====

const handleAutoAccept = async (ctx) => {
    if (typeof currentEngine !== 'undefined' && currentEngine === 'claude') {
        return ctx.reply(t('feature.claude_unsupported') || '❌ This feature is currently only available in Antigravity mode.');
    }
    const text = ctx.message.text || '';
    const parts = text.split(' ');
    parts.shift();
    const subCommand = parts.join(' ').trim().toLowerCase();

    try {
        if (subCommand === 'on' || (subCommand === '' && !autoaccept.isEnabled)) {
            // Enable auto-accept
            ctx.reply(t('autoaccept.enabling'));
            const result = await autoaccept.enable(CDP_PORT);
            let responseText = '';
            if (result.injected > 0) {
                responseText = t('autoaccept.enabled', { injected: result.injected });
            } else {
                responseText = t('autoaccept.enabled_none');
            }
            // If toggled via button click, refresh menu
            if (subCommand === '') await sendMainMenu(ctx, responseText);
            else ctx.reply(responseText);
        } else if (subCommand === 'off' || (subCommand === '' && autoaccept.isEnabled)) {
            // Disable auto-accept
            ctx.reply(t('autoaccept.disabling'));
            const result = await autoaccept.disable(CDP_PORT);
            const responseText = t('autoaccept.disabled', { clicks: result.totalClicks });
            // If toggled via button click, refresh menu
            if (subCommand === '') await sendMainMenu(ctx, responseText);
            else ctx.reply(responseText);
        } else if (subCommand === 'status') {
            // Show status
            const status = await autoaccept.getStatus(CDP_PORT);
            let msg = t('autoaccept.status_title');
            msg += (status.enabled ? t('autoaccept.status_enabled') : t('autoaccept.status_disabled')) + '\n';

            // Observer status
            if (status.active) {
                msg += t('autoaccept.status_active', { targets: status.injectedTargets }) + '\n';
            } else {
                msg += t('autoaccept.status_inactive') + '\n';
            }

            // Click stats
            msg += t('autoaccept.status_clicks', { total: status.totalClicks, session: status.sessionClicks }) + '\n';

            // Last click info
            if (status.lastClickText && status.lastClickTimeSec !== null) {
                msg += t('autoaccept.status_last_click', { text: status.lastClickText, sec: status.lastClickTimeSec }) + '\n';
            }

            // Blocked commands
            msg += t('autoaccept.status_blocked', { count: status.blockedCommandsCount }) + '\n';

            // Agent panel warning
            if (!status.hasAgentPanel) {
                msg += '\n' + t('autoaccept.status_no_panel');
            }

            ctx.reply(msg, { parse_mode: 'HTML' });
        } else {
            // Unknown subcommand — show inline buttons
            const buttons = [
                [{ text: '⚡ ' + (autoaccept.isEnabled ? t('menu.btn_off') : t('menu.btn_on')), callback_data: autoaccept.isEnabled ? 'aa_off' : 'aa_on' }],
                [{ text: t('menu.btn_status'), callback_data: 'aa_status' }]
            ];
            ctx.reply(t('autoaccept.status_title') + (autoaccept.isEnabled ? t('autoaccept.status_enabled') : t('autoaccept.status_disabled')), {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: buttons }
            });
        }
    } catch (e) {
        ctx.reply(t('autoaccept.error', { error: e.message }));
    }
};

bot.command('autoaccept', handleAutoAccept);
bot.hears(/^(⚡|🔴)/i, handleAutoAccept);

bot.action('aa_on', async (ctx) => {
    try {
        ctx.answerCbQuery('Enabling...');
        const result = await autoaccept.enable(CDP_PORT);
        if (result.injected > 0) {
        }
        
        // Refresh the keyboard menu to update the button icon
        await sendMainMenu(ctx, t('autoaccept.enabled', { injected: result.injected }));
    } catch (e) {
        ctx.reply(t('autoaccept.error', { error: e.message }));
    }
});

bot.action('aa_off', async (ctx) => {
    try {
        ctx.answerCbQuery('Disabling...');
        const result = await autoaccept.disable(CDP_PORT);
        
        // Refresh the keyboard menu to update the button icon
        await sendMainMenu(ctx, t('autoaccept.disabled', { clicks: result.totalClicks }));
    } catch (e) {
        ctx.reply(t('autoaccept.error', { error: e.message }));
    }
});

bot.action('aa_status', async (ctx) => {
    try {
        ctx.answerCbQuery('Loading...');
        const status = await autoaccept.getStatus(CDP_PORT);
        let msg = t('autoaccept.status_title');
        msg += (status.enabled ? t('autoaccept.status_enabled') : t('autoaccept.status_disabled')) + '\n';
        if (status.active) msg += t('autoaccept.status_active', { targets: status.injectedTargets }) + '\n';
        else msg += t('autoaccept.status_inactive') + '\n';
        msg += t('autoaccept.status_clicks', { total: status.totalClicks, session: status.sessionClicks }) + '\n';
        if (status.lastClickText && status.lastClickTimeSec !== null) {
            msg += t('autoaccept.status_last_click', { text: status.lastClickText, sec: status.lastClickTimeSec }) + '\n';
        }
        
        if (ctx.callbackQuery && ctx.callbackQuery.message) {
            const kb = ctx.callbackQuery.message.reply_markup;
            ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: kb }).catch(e => {
                if (!e.message.includes('message is not modified')) ctx.reply(msg, { parse_mode: 'HTML' });
            });
        } else {
            ctx.reply(msg, { parse_mode: 'HTML' });
        }
    } catch (e) {
        ctx.reply(t('autoaccept.error', { error: e.message }));
    }
});

// ===== WORKSPACE =====

async function doLaunchWorkspace(ctx, workspace) {
    let switchingMsg;
    if (ctx.callbackQuery && ctx.callbackQuery.message) {
        try {
            await ctx.editMessageText(t('workspace.switching', { workspace })).catch(()=>{});
            switchingMsg = ctx.callbackQuery.message;
        } catch(e) {}
    } else {
        try {
            switchingMsg = await ctx.reply(t('workspace.switching', { workspace }));
        } catch(e) {}
    }

    try {
        const activeApp = process.env.ANTIGRAVITY_PREFERRED_APP || 'agent';
        const wsName = path.basename(workspace);
        
        // Standalone Agent 2.0 Hızlı Geçiş:
        // Eğer 'agent' aktifse ve çalışıyorsa, sol menüdeki proje kartına tıklayarak 1 saniyede geçiş yapar!
        if (activeApp === 'agent') {
            const running = await isIDERunning('agent');
            if (running) {
                try {
                    const success = await switchStandaloneWorkspace(CDP_PORT, wsName);
                    if (success) {
                        setActiveWorkspace(wsName);
                        setPreferredWindow(null);
                        if (autoaccept.isEnabled) {
                            autoaccept.enable(CDP_PORT).catch(() => {});
                        }
                        await triggerNewChat(CDP_PORT);
                        const successMsg = t('workspace.started', { workspace }) || '📁 Workspace switched successfully!';
                        if (switchingMsg && switchingMsg.message_id) {
                            ctx.deleteMessage(switchingMsg.message_id).catch(()=>{});
                        }
                        await sendMainMenu(ctx, successMsg);
                        return;
                    }
                } catch (e) {
                    console.debug('[doLaunchWorkspace] Standalone quick switch failed:', e.message);
                }
            } else {
                try {
                    await launchIDE(null, CDP_PORT, 'agent');
                    await new Promise(r => setTimeout(r, 4000));
                    const success = await switchStandaloneWorkspace(CDP_PORT, wsName);
                    if (success) {
                        setActiveWorkspace(wsName);
                        setPreferredWindow(null);
                        if (autoaccept.isEnabled) {
                            autoaccept.enable(CDP_PORT).catch(() => {});
                        }
                        await triggerNewChat(CDP_PORT);
                        const successMsg = t('workspace.started', { workspace }) || '📁 Workspace switched successfully!';
                        if (switchingMsg && switchingMsg.message_id) {
                            ctx.deleteMessage(switchingMsg.message_id).catch(()=>{});
                        }
                        await sendMainMenu(ctx, successMsg);
                        return;
                    }
                } catch (e) {
                    console.debug('[doLaunchWorkspace] Standalone launch and switch failed:', e.message);
                }
            }
            await sendMainMenu(ctx, t('workspace.not_found_standalone', { wsName }));
            return;
        }
        
        // Multi-window support: DO NOT kill existing IDE instances!
        // We just launch the new workspace.
        
        try {
            await launchIDE(workspace, CDP_PORT);
            if (workspace) {
                setActiveWorkspace(path.basename(workspace));
            }
            // Poll CDP until the new IDE is responsive (max 30 seconds)
            let cdpReady = false;
            for (let i = 0; i < 15; i++) {
                await new Promise(r => setTimeout(r, 2000));
                try {
                    const http = require('http');
                    const targets = await new Promise((resolve, reject) => {
                        http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
                            let data = '';
                            res.on('data', chunk => data += chunk);
                            res.on('end', () => {
                                try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
                            });
                        }).on('error', reject);
                    });
                    if (targets && targets.length > 0) {
                        const targetWsName = workspace ? path.basename(workspace).toLowerCase() : null;
                        const foundNew = targetWsName ? targets.some(t => t.title && t.title.toLowerCase().includes(targetWsName)) : true;
                        if (foundNew) {
                            cdpReady = true;
                            break;
                        }
                    }
                } catch (_) {
                    // CDP not ready yet, keep waiting
                }
            }
            if (cdpReady) {
                const successMsg = t('workspace.started', { workspace });
                if (switchingMsg && switchingMsg.message_id) {
                    ctx.deleteMessage(switchingMsg.message_id).catch(()=>{});
                }
                await sendMainMenu(ctx, successMsg);
                // trustWorkspaceViaCDP removed — CDP intervention during startup
                // interrupts Electron's init/sync and prevents state.vscdb from saving
                
                // Clear preferred window when workspace changes
                setPreferredWindow(null);
                
                // Re-inject autoaccept into the new window immediately
                if (autoaccept.isEnabled) {
                    autoaccept.enable(CDP_PORT).catch(() => {});
                }
            } else {
                ctx.reply(t('workspace.started', { workspace }) + t('workspace.cdp_warning'));
            }
        } catch (err) {
            console.error('doLaunchWorkspace error:', err);
            ctx.reply(t('workspace.start_failed', { error: err.message }));
        }
    } catch (e) {
        console.error('doLaunchWorkspace async wrap error:', e);
    }
}

const handleWorkspace = (ctx) => {
    let workspace = '';
    if (ctx.message && ctx.message.text) {
        let text = ctx.message.text.trim();
        if (text.startsWith('🤖')) {
            text = text.substring(2).trim();
        }
        const parts = text.split(' ');
        if (parts[0].startsWith('/')) parts.shift();
        workspace = parts.join(' ').trim();
        if (workspace.toLowerCase().startsWith('workspace:')) {
            workspace = workspace.substring(10).trim();
        }
    }
    
    let isValid = false;
    let wsPath = '';
    if (workspace) {
        wsPath = workspace.startsWith('/') || workspace.includes(':') ? workspace : path.join(config.projectsDir, workspace);
        try {
            isValid = fs.statSync(wsPath).isDirectory();
        } catch (e) {
            isValid = false;
        }
    }
    
    if (!workspace || !isValid) {
        const projectsDir = config.projectsDir;
        fs.readdir(projectsDir, { withFileTypes: true }, (err, files) => {
            if (err) return ctx.reply(t('workspace.read_error'));
            const dirs = files.filter(f => {
                if (f.name.startsWith('.')) return false;
                if (f.isDirectory()) return true;
                if (f.isSymbolicLink()) {
                    try {
                        return fs.statSync(path.join(projectsDir, f.name)).isDirectory();
                    } catch (e) {
                        return false;
                    }
                }
                return false;
            }).map(f => f.name);
            const buttons = dirs.map(d => [{ text: `📂 ${d}`, callback_data: `ws_${d}` }]);
            
            ctx.reply(t('workspace.select_prompt'), {
                reply_markup: { inline_keyboard: buttons }
            });
        });
        return;
    }
    
    currentWorkspaceDir = wsPath;
    if (typeof currentEngine !== 'undefined' && currentEngine === 'claude') {
        updateEnvFile('CLAUDE_WORK_DIR', wsPath);
        resetSession(String(ctx.chat.id));
        ctx.reply(`✅ Đã chuyển thư mục làm việc của Claude Code sang:\n<code>${wsPath}</code>\n\n(Session cũ đã được reset để bắt đầu trong thư mục mới)`, { parse_mode: 'HTML' });
        sendMainMenu(ctx, `Thư mục hiện tại: <b>${path.basename(wsPath)}</b>`);
        return;
    }
    doLaunchWorkspace(ctx, wsPath);
};
bot.command('workspace', handleWorkspace);
bot.hears(/^📁/i, handleWorkspace);

bot.action(/ws_(.+)/, (ctx) => {
    const project = ctx.match[1];
    const wsPath = path.join(config.projectsDir, project);
    currentWorkspaceDir = wsPath;
    ctx.answerCbQuery(t('workspace.selected', { project }));
    if (typeof currentEngine !== 'undefined' && currentEngine === 'claude') {
        updateEnvFile('CLAUDE_WORK_DIR', wsPath);
        resetSession(String(ctx.chat.id));
        let msg = `✅ Đã chuyển thư mục làm việc của Claude Code sang:\n<code>${wsPath}</code>\n\n(Session cũ đã được reset để bắt đầu trong thư mục mới)`;
        if (ctx.callbackQuery && ctx.callbackQuery.message) {
            ctx.editMessageText(msg, { parse_mode: 'HTML' }).catch(()=>{});
        } else {
            ctx.reply(msg, { parse_mode: 'HTML' });
        }
        sendMainMenu(ctx, `Thư mục hiện tại: <b>${project}</b>`);
        return;
    }
    doLaunchWorkspace(ctx, wsPath);
});

// ===== LANGUAGE SWITCH =====

bot.command('lang', async (ctx) => {
    const parts = ctx.message.text.split(' ');
    parts.shift();
    const newLang = parts.join(' ').trim().toLowerCase();
    
    const availableLangs = fs.readdirSync(path.join(__dirname, '..', 'locales'))
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''));

    if (newLang && availableLangs.includes(newLang)) {
        loadLocale(newLang);
        saveLangState(newLang);
        await clearAllMenuScopes();
        await setMenuOnAllScopes();
        await sendMainMenu(ctx, t('lang.changed', { lang: newLang }));
        return;
    }
    
    const langMap = {
        'en': '🇬🇧 English',
        'zh': '🇨🇳 中文',
        'tr': '🇹🇷 Türkçe',
        'es': '🇪🇸 Español',
        'fr': '🇫🇷 Français',
        'de': '🇩🇪 Deutsch',
        'ko': '🇰🇷 한국어'
    };
    
    const buttons = availableLangs.map(l => {
        return [{ text: langMap[l] || l.toUpperCase(), callback_data: `lang_${l}` }];
    });
    
    ctx.reply(t('lang.select_prompt'), {
        reply_markup: { inline_keyboard: buttons }
    });
});

bot.action(/lang_(.+)/, async (ctx) => {
    const newLang = ctx.match[1];
    loadLocale(newLang);
    saveLangState(newLang);
    await clearAllMenuScopes();
    await setMenuOnAllScopes();
    ctx.answerCbQuery(t('lang.changed', { lang: newLang }));
    await sendMainMenu(ctx, t('lang.changed', { lang: newLang }));
});


// ===== DUAL APP SWITCHER =====

bot.command('app', async (ctx) => {
    const currentApp = process.env.ANTIGRAVITY_PREFERRED_APP || 'agent';
    const appName = currentApp === 'ide' ? '💻 Classic Monaco IDE' : '🤖 Standalone Agent (2.0)';
    const currentPort = CDP_PORT;
    
    const agentPort = getCDPPort('agent');
    const idePort = getCDPPort('ide');

    let msg = t('app.selection_title') || `🤖 <b>Antigravity App Selection</b>\n\n`;
    msg += t('app.preferred_app', { appName }) + '\n';
    msg += t('app.active_port', { port: currentPort }) + '\n\n';
    msg += t('app.select_prompt') + '\n';
    msg += `• <b>Standalone Agent:</b> CDP Port ${agentPort}\n`;
    msg += `• <b>Monaco IDE:</b> CDP Port ${idePort}\n\n`;
    msg += t('app.persistent_selection') || `⚡ <i>Your selection is permanently saved to the .env file and applied instantly without restarting the bot.</i>`;

    const buttons = [
        [{ text: `🤖 Standalone Agent (Port: ${agentPort})`, callback_data: 'pref_app_agent' }],
        [{ text: `💻 Classic Monaco IDE (Port: ${idePort})`, callback_data: 'pref_app_ide' }]
    ];

    ctx.reply(msg, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons }
    });
});

bot.action(/pref_app_(.+)/, async (ctx) => {
    const selectedApp = ctx.match[1]; // 'agent' or 'ide'
    const success = updateEnvFile('ANTIGRAVITY_PREFERRED_APP', selectedApp);
    
    if (success) {
        // Recalculate port
        CDP_PORT = getCDPPort();
        ctx.answerCbQuery(t('app.updated_preference', { app: selectedApp }));
        
        const appName = selectedApp === 'ide' ? '💻 Classic Monaco IDE' : '🤖 Standalone Agent (2.0)';
        let msg = t('app.updated_title');
        msg += t('app.preferred_app', { appName });
        msg += t('app.new_port', { port: CDP_PORT });
        msg += t('app.redirect_info');
        
        ctx.reply(msg, { parse_mode: 'HTML' });
        
        // Seçilen uygulama açık değilse otomatik başlat
        try {
            const running = await isIDERunning(selectedApp);
            if (!running) {
                ctx.reply(t('app.auto_starting', { appName }));
                await launchIDE(null, CDP_PORT, selectedApp);
                // Uygulamanın açılması için biraz bekle
                await new Promise(r => setTimeout(r, 4000));
                ctx.reply(t('app.started', { appName }));
            }
        } catch (err) {
            console.error('[App Switch] Auto-start failed:', err.message);
        }
        
        // Autoaccept status reload for new port
        if (autoaccept.isEnabled) {
            autoaccept.enable(CDP_PORT).catch(() => {});
        }
        
        await sendMainMenu(ctx, t('app.control_panel', { app: selectedApp === 'ide' ? 'IDE' : 'Agent' }));
    } else {
        ctx.answerCbQuery(t('app.error_save'));
    }
});

// ===== SHORTCUTS FIXER =====

bot.command('fix_shortcuts', async (ctx) => {
    ctx.reply(t('shortcuts.scanning'));
    
    const platform = require('./platform').PLATFORM;
    const { getAppBinary } = require('./platform');
    const agentPort = getCDPPort('agent');
    const idePort = getCDPPort('ide');
    
    if (platform === 'linux') {
        // Linux: Update launcher scripts and .desktop files
        try {
            const localBin = path.join(os.homedir(), '.local', 'bin');
            const desktop = path.join(os.homedir(), 'Desktop');
            let fixedCount = 0;
            let status = t('shortcuts.updated_header');

            // Ensure directories exist
            if (!fs.existsSync(localBin)) fs.mkdirSync(localBin, { recursive: true });

            // --- 1. IDE Launcher ---
            const ideBinary = getAppBinary('ide');
            const ideLauncherPath = path.join(localBin, 'antigravity-ide-launcher.sh');
            const ideDesktopPath = path.join(desktop, 'Antigravity-IDE-CDP.desktop');
            
            if (fs.existsSync(ideBinary) || fs.existsSync(require('fs').realpathSync(ideBinary).replace(/\/[^/]+$/, ''))) {
                const ideLauncher = `#!/bin/bash\n# Antigravity IDE Launcher — Port ${idePort}\nPORT=${idePort}\nAPP_PATH="${ideBinary}"\n\n# Check if the IDE is already listening on the port\nLISTENING_PIDS=$(lsof -t -i :$PORT -s TCP:LISTEN 2>/dev/null || true)\n\nif [ -n "$LISTENING_PIDS" ]; then\n    echo "[launcher-ide] IDE already running. Opening a new window..."\n    $APP_PATH "$@"\n    exit 0\nfi\n\necho "[launcher-ide] Starting fresh IDE instance..."\n# Clean up stale locks just in case\nrm -f "$HOME/.config/Antigravity IDE/code.lock"\nrm -f "$HOME/.config/Antigravity-IDE/code.lock"\n\n$APP_PATH --remote-debugging-port=$PORT "$@" &\\nAG_PID=$!\\nwait $AG_PID\\n`;
                fs.writeFileSync(ideLauncherPath, ideLauncher, { mode: 0o755 });

                const ideDesktop = `[Desktop Entry]\nName=Antigravity IDE (CDP ${idePort})\nComment=Start Antigravity IDE with CDP ${idePort}\nExec=${ideLauncherPath} %F\nIcon=antigravity-ide\nType=Application\nTerminal=false\nStartupNotify=false\nStartupWMClass=antigravity-ide\nCategories=Development;IDE;\nMimeType=application/x-antigravity-workspace;\n`;
                fs.writeFileSync(ideDesktopPath, ideDesktop);
                exec(`chmod +x "${ideDesktopPath}"`);
                status += `• 💻 <b>Antigravity IDE</b> -> <code>--remote-debugging-port=${idePort}</code> ✅\n`;
                fixedCount++;
            } else {
                status += `• 💻 <i>Antigravity IDE</i> (${t('shortcuts.binary_not_found')})\n`;
            }

            // --- 2. Standalone Agent ---
            const agentBinary = getAppBinary('agent');
            const agentLauncherPath = path.join(localBin, 'antigravity-standalone-launcher.sh');
            const agentDesktopPath = path.join(desktop, 'Antigravity-Standalone-CDP.desktop');
            
            if (fs.existsSync(agentBinary)) {
                const agentLauncher = `#!/bin/bash\n# Antigravity Standalone Launcher — Port ${agentPort}\nPORT=${agentPort}\nAPP_PATH="${agentBinary}"\n\n# Check if the Standalone App is already listening on the port\nLISTENING_PIDS=$(lsof -t -i :$PORT -s TCP:LISTEN 2>/dev/null || true)\n\nif [ -n "$LISTENING_PIDS" ]; then\n    echo "[launcher-standalone] Standalone App already running. Opening a new window..."\n    $APP_PATH "$@"\n    exit 0\nfi\n\necho "[launcher-standalone] Starting fresh Standalone App instance..."\n# Clean up stale locks just in case\nrm -f "$HOME/.config/Antigravity/code.lock"\n\n$APP_PATH --remote-debugging-port=$PORT "$@" &\\nAG_PID=$!\\nwait $AG_PID\\n`;
                fs.writeFileSync(agentLauncherPath, agentLauncher, { mode: 0o755 });

                const agentDesktop = `[Desktop Entry]\nName=Antigravity Standalone (CDP ${agentPort})\nComment=Start Antigravity Standalone Agent with CDP ${agentPort}\nExec=${agentLauncherPath} %F\nIcon=antigravity-standalone\nType=Application\nTerminal=false\nStartupNotify=false\nStartupWMClass=antigravity\nCategories=Development;IDE;\nMimeType=application/x-antigravity-workspace;\n`;
                fs.writeFileSync(agentDesktopPath, agentDesktop);
                exec(`chmod +x "${agentDesktopPath}"`);
                status += `• 🤖 <b>Antigravity Standalone</b> -> <code>--remote-debugging-port=${agentPort}</code> ✅\n`;
                fixedCount++;
            } else {
                status += `• 🤖 <i>Antigravity Standalone</i> (${t('shortcuts.binary_not_found')})\n`;
            }

            status += t('shortcuts.success', { count: fixedCount });
            ctx.reply(status, { parse_mode: 'HTML' });
        } catch (e) {
            ctx.reply(t('shortcuts.start_error', { error: e.message }));
        }
    } else if (platform === 'win32') {
        // Windows: PowerShell approach
        const psScriptPath = path.join(os.tmpdir(), 'fix_shortcuts.ps1');
        const psScript = `
$sh = New-Object -ComObject WScript.Shell
$desktop = [System.IO.Path]::Combine($env:USERPROFILE, "Desktop")

# 1. Standalone Agent (Port ${agentPort})
$lnkAgent = Join-Path $desktop "Antigravity.lnk"
if (Test-Path $lnkAgent) {
    $lnk = $sh.CreateShortcut($lnkAgent)
    $lnk.Arguments = "--remote-debugging-port=${agentPort}"
    $lnk.Save()
    Write-Output "agent-fixed"
}

# 2. Classic IDE (Port ${idePort})
$lnkIDE = Join-Path $desktop "Antigravity IDE.lnk"
if (Test-Path $lnkIDE) {
    $lnk = $sh.CreateShortcut($lnkIDE)
    $lnk.Arguments = "--remote-debugging-port=${idePort}"
    $lnk.Save()
    Write-Output "ide-fixed"
}
`;

        try {
            fs.writeFileSync(psScriptPath, psScript, 'utf8');
            exec(`powershell -ExecutionPolicy Bypass -File "${psScriptPath}"`, (err, stdout, stderr) => {
                try { fs.unlinkSync(psScriptPath); } catch (_) {}
                
                if (err) {
                    console.error('[fix_shortcuts] Error:', err);
                    return ctx.reply(t('shortcuts.error', { error: err.message }), { parse_mode: 'HTML' });
                }
                
                let status = t('shortcuts.updated_header');
                const output = stdout.toLowerCase();
                let fixedCount = 0;
                if (output.includes('agent-fixed')) {
                    status += `\u2022 \ud83e\udd16 <b>Antigravity.lnk</b> -> <code>--remote-debugging-port=${agentPort}</code> \u2705\n`;
                    fixedCount++;
                } else {
                    status += '\u2022 \ud83e\udd16 <i>Antigravity.lnk</i> (' + t('shortcuts.not_found') + ')\n';
                }
                if (output.includes('ide-fixed')) {
                    status += `\u2022 \ud83d\udcbb <b>Antigravity IDE.lnk</b> -> <code>--remote-debugging-port=${idePort}</code> \u2705\n`;
                    fixedCount++;
                } else {
                    status += '\u2022 \ud83d\udcbb <i>Antigravity IDE.lnk</i> (' + t('shortcuts.not_found') + ')\n';
                }
                
                status += t('shortcuts.success', { count: fixedCount });
                ctx.reply(status, { parse_mode: 'HTML' });
            });
        } catch (e) {
            ctx.reply(t('shortcuts.start_error', { error: e.message }));
        }
    } else if (platform === 'darwin') {
        // macOS: osacompile kullanarak masaüstüne başlatıcı .app'ler oluşturur
        try {
            const { execSync } = require('child_process');
            const desktop = path.join(os.homedir(), 'Desktop');
            let fixedCount = 0;
            let status = t('shortcuts.updated');
            
            // 1. Standalone Agent (Port ${agentPort})
            const agentBinary = getAppBinary('agent'); // Uygulamanın .app dizinini döndürür
            if (fs.existsSync(agentBinary)) {
                const agentAppPath = path.join(desktop, 'Antigravity Agent (CDP).app');
                // open -a komutuyla uygulamayı debug portu ile başlatacak script
                const script = `do shell script "open -a \\"${agentBinary}\\" --args --remote-debugging-port=${agentPort}"`;
                execSync(`osacompile -e '${script}' -o "${agentAppPath}"`);
                status += `• 🤖 <b>Antigravity Agent (CDP).app</b> -> <code>Port ${agentPort}</code> ✅\n`;
                fixedCount++;
            }
            
            // 2. Classic IDE (Port ${idePort})
            const ideBinary = getAppBinary('ide');
            if (fs.existsSync(ideBinary)) {
                const ideAppPath = path.join(desktop, 'Antigravity IDE (CDP).app');
                const script = `do shell script "open -a \\"${ideBinary}\\" --args --remote-debugging-port=${idePort}"`;
                execSync(`osacompile -e '${script}' -o "${ideAppPath}"`);
                status += `• 💻 <b>Antigravity IDE (CDP).app</b> -> <code>Port ${idePort}</code> ✅\n`;
                fixedCount++;
            }
            
            status += t('shortcuts.success', { count: fixedCount });
            ctx.reply(status, { parse_mode: 'HTML' });
        } catch (e) {
            ctx.reply(t('shortcuts.start_error', { error: e.message }));
        }
    } else {
        ctx.reply(t('shortcuts.unsupported_platform') || '\u26a0\ufe0f Bu platform i\u00e7in k\u0131sayol d\u00fczeltme hen\u00fcz desteklenmiyor.');
    }
});


// ===== WINDOW SELECTION =====

bot.command('window', async (ctx) => {
    try {
        const windows = await listWindows(CDP_PORT);
        if (windows.length === 0) {
            return ctx.reply(t('window.not_found') || 'No IDE windows found. Send /start_ide first.');
        }
        
        const current = getPreferredWindow();
        let msg = t('window.title') || '<b>🔳 IDE Windows</b>\n';
        if (current) {
            const currentLabel = current.length > 40 ? current.substring(0, 40) + '...' : current;
            msg += (t('window.current', { current: currentLabel }) || `Current target: <i>${currentLabel}</i>`) + '\n';
        } else {
            msg += (t('window.auto') || 'Target: <i>auto (first available)</i>') + '\n';
        }
        msg += '\n' + (t('window.found', { count: windows.length }) || `Found ${windows.length} window(s). Tap to select:`);
        
        const buttons = windows.map((w, i) => {
            const icon = w.isPreferred ? '✅' : '🔳';
            // Extract meaningful part of title (usually "folder - Antigravity")
            const label = w.title.length > 40 ? w.title.substring(0, 40) + '...' : w.title;
            return [{ text: `${icon} ${label}`, callback_data: `wn_${w.id.substring(0,8)}` }];
        });
        
        // Add "auto" button to clear preference
        if (current) {
            buttons.push([{ text: t('window.clear_btn') || '🔄 Auto (clear preference)', callback_data: 'wn_auto' }]);
        }
        
        ctx.reply(msg, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: buttons }
        });
    } catch (e) {
        ctx.reply((t('window.error', { error: e.message }) || `Window list error: ${e.message}`));
    }
});

bot.action('wn_auto', (ctx) => {
    setPreferredWindow(null);
    ctx.answerCbQuery(t('window.cleared_toast') || 'Cleared — using auto-detect');
    const text = t('window.cleared_msg') || '🔄 Window preference cleared. Bot will auto-detect the active IDE window.';
    if (ctx.callbackQuery && ctx.callbackQuery.message) {
        ctx.editMessageText(text).catch(e => {
            if (!e.message.includes('message is not modified')) ctx.reply(text);
        });
    } else {
        ctx.reply(text);
    }
});

bot.action(/wn_(.+)/, (ctx) => {
    const idPrefix = ctx.match[1];
    const windows = getCachedWindows();
    if (!windows || windows.length === 0) {
        return ctx.answerCbQuery(t('window.expired') || 'Window list expired. Send /window again.');
    }
    const selected = windows.find(w => w.id.startsWith(idPrefix));
    if (!selected) {
        return ctx.answerCbQuery(t('window.expired') || 'Window list expired. Send /window again.');
    }
    
    // Save preference by ID
    setPreferredWindow(selected.id);
    const shortTitle = selected.title.substring(0, 30);
    ctx.answerCbQuery(t('window.selected_toast', { title: shortTitle }) || `Selected: ${shortTitle}`);
    
    const text = t('window.selected_msg', { title: selected.title }) || `✅ Now targeting: <b>${selected.title}</b>\n\nAll commands will route to this window.`;
    if (ctx.callbackQuery && ctx.callbackQuery.message) {
        ctx.editMessageText(text, { parse_mode: 'HTML' }).catch(e => {
            if (!e.message.includes('message is not modified')) ctx.reply(text, { parse_mode: 'HTML' });
        });
    } else {
        ctx.reply(text, { parse_mode: 'HTML' });
    }
    
    // Auto-show latest agent response from the new window
    (async () => {
        try {
            await new Promise(r => setTimeout(r, 800));
            let _latestRes = await getFullLatestResponse(CDP_PORT);
            let text = typeof _latestRes === 'string' ? _latestRes : _latestRes.text;
            let buttons = typeof _latestRes === 'string' ? null : _latestRes.buttons;
            
            if (text && !text.startsWith('[No previous')) {
                const header = await getChatHeader(null, t('latest.last_agent_reply'));
                await sendLongMessage(ctx, text, header, buttons);
            }
        } catch(_) {}
    })();

    // Explicitly re-inject autoaccept into the selected window to ensure it tracks
    if (autoaccept.isEnabled) {
        autoaccept.enable(CDP_PORT).catch(() => {});
    }
});

bot.action(/focus_(.+)/, async (ctx) => {
    const idPrefix = ctx.match[1];
    const windows = await listWindows(CDP_PORT);
    const selected = windows.find(w => w.id.startsWith(idPrefix));
    if (!selected) {
        return ctx.answerCbQuery(t('agents.window_not_found'));
    }
    setPreferredWindow(selected.id);
    const shortTitle = selected.title.substring(0, 30);
    ctx.answerCbQuery(t('ask.focus_toast', { title: shortTitle }));
    ctx.reply(t('ask.focus_success', { title: selected.title }), { 
        parse_mode: 'HTML',
        reply_parameters: { message_id: ctx.callbackQuery.message.message_id, allow_sending_without_reply: true }
    });
});

// ===== FILE EXPLORER =====

let currentWorkspaceDir = config.projectsDir;

const pathCache = new Map();
let pathIdCounter = 0;
function getPathId(fullPath) {
    for (const [id, p] of pathCache.entries()) {
        if (p === fullPath) return id;
    }
    const id = (++pathIdCounter).toString(36);
    pathCache.set(id, fullPath);
    if (pathCache.size > 2000) {
        const firstKey = pathCache.keys().next().value;
        pathCache.delete(firstKey);
    }
    return id;
}

function listDirectory(ctx, dirPath, page = 0) {
    const PAGE_SIZE = 8;
    fs.readdir(dirPath, { withFileTypes: true }, (err, entries) => {
        if (err) return ctx.reply(t('file.dir_read_error', { error: err.message }));
        
        const filtered = entries
            .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
            .sort((a, b) => {
                if (a.isDirectory() && !b.isDirectory()) return -1;
                if (!a.isDirectory() && b.isDirectory()) return 1;
                return a.name.localeCompare(b.name);
            });
        
        const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
        const pageEntries = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
        
        if (pageEntries.length === 0) {
            return ctx.reply(t('file.empty_dir'));
        }
        
        const buttons = pageEntries.map(e => {
            const icon = e.isDirectory() ? '📂' : '📄';
            const fullPath = path.join(dirPath, e.name);
            const pathId = getPathId(fullPath);
            const action = e.isDirectory() ? 'fd_' : 'ff_';
            return [{ text: `${icon} ${e.name}`, callback_data: `${action}${pathId}` }];
        });
        
        const navRow = [];
        const parentDir = path.dirname(dirPath);
        if (parentDir !== dirPath && dirPath !== config.projectsDir) {
            const parentId = getPathId(parentDir);
            navRow.push({ text: t('file.parent_dir'), callback_data: `fd_${parentId}` });
        }
        
        const dirPathId = getPathId(dirPath);
        if (page > 0) {
            navRow.push({ text: t('file.prev_page'), callback_data: `fp_${dirPathId}|${page - 1}` });
        }
        if (page < totalPages - 1) {
            navRow.push({ text: t('file.next_page'), callback_data: `fp_${dirPathId}|${page + 1}` });
        }
        if (navRow.length > 0) buttons.push(navRow);
        
        const relativePath = dirPath.replace(config.home, '~');
        const dirInfo = t('file.dir_info', { count: filtered.length, page: page + 1, totalPages: totalPages || 1 });
        const text = `📂 <b>${relativePath}</b>\n${dirInfo}`;
        const extra = {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: buttons }
        };
        
        if (ctx.callbackQuery && ctx.callbackQuery.message) {
            ctx.editMessageText(text, extra).catch(e => {
                if (!e.message.includes('message is not modified')) {
                    ctx.reply(text, extra);
                }
            });
        } else {
            ctx.reply(text, extra);
        }
    });
}

bot.command('file', (ctx) => {
    const parts = ctx.message.text.split(' ');
    parts.shift();
    const filePath = parts.join(' ').trim();
    
    if (!filePath) {
        listDirectory(ctx, currentWorkspaceDir);
        return;
    }
    
    const fullPath = filePath.startsWith('/') || filePath.match(/^[A-Z]:\\/) 
        ? filePath 
        : path.join(currentWorkspaceDir, filePath);
    if (!fs.existsSync(fullPath)) {
        return ctx.reply(t('file.not_found', { path: fullPath }));
    }
    
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
        listDirectory(ctx, fullPath);
        return;
    }
    
    if (stat.size > 50 * 1024 * 1024) {
        return ctx.reply(t('file.too_large', { size: (stat.size / 1024 / 1024).toFixed(1) }));
    }
    
    ctx.replyWithDocument({ source: fullPath, filename: path.basename(fullPath) })
        .catch(e => ctx.reply(t('file.send_failed', { error: e.message })));
});

bot.action(/fd_(.+)/, (ctx) => {
    try {
        const pathId = ctx.match[1];
        const dirPath = pathCache.get(pathId);
        if (!dirPath) return ctx.answerCbQuery(t('file.expired'));
        ctx.answerCbQuery();
        listDirectory(ctx, dirPath);
    } catch(e) {
        ctx.answerCbQuery(t('model.error'));
    }
});

bot.action(/ff_(.+)/, (ctx) => {
    try {
        const pathId = ctx.match[1];
        const filePath = pathCache.get(pathId);
        if (!filePath) return ctx.answerCbQuery(t('file.expired'));
        
        ctx.answerCbQuery(t('file.sending', { filename: path.basename(filePath) }));
        
        const stat = fs.statSync(filePath);
        if (stat.size > 50 * 1024 * 1024) {
            return ctx.reply(t('file.too_large', { size: (stat.size / 1024 / 1024).toFixed(1) }));
        }
        
        ctx.replyWithDocument({ source: filePath, filename: path.basename(filePath) })
            .catch(e => ctx.reply(t('file.send_failed', { error: e.message })));
    } catch(e) {
        ctx.answerCbQuery(t('model.error'));
    }
});

bot.action(/fp_(.+)/, (ctx) => {
    try {
        const matchData = ctx.match[1];
        const [pathId, pageStr] = matchData.split('|');
        const dirPath = pathCache.get(pathId);
        if (!dirPath) return ctx.answerCbQuery(t('file.expired'));
        
        ctx.answerCbQuery();
        listDirectory(ctx, dirPath, parseInt(pageStr) || 0);
    } catch(e) {
        ctx.answerCbQuery(t('model.error'));
    }
});

// ===== MENU REGISTRATION =====

function getMenuCommands() {
    const cmds = [
        { command: 'help', description: t('menu.help_desc') },
        { command: 'latest', description: t('menu.latest_desc') },
        { command: 'screenshot', description: t('menu.screenshot_desc') },
        { command: 'status', description: t('menu.status_desc') },
        { command: 'start_ide', description: t('menu.start_ide_desc') || 'Start IDE' },
        { command: 'start_ag', description: t('menu.start_ag_desc') || 'Start Agent' },
        { command: 'close_ide', description: t('menu.close_ide_desc') || 'Close IDE' },
        { command: 'close_ag', description: t('menu.close_ag_desc') || 'Close Agent' },
        { command: 'new', description: t('menu.new_desc') },
        { command: 'agents', description: t('menu.agents_desc') },
        { command: 'artifacts', description: t('menu.artifacts_desc') },
        { command: 'model', description: t('menu.model_desc') },
        { command: 'workspace', description: t('menu.workspace_desc') },
        { command: 'window', description: t('menu.window_desc') || 'Select IDE window' },
        { command: 'close_window', description: t('menu.close_window_desc') || 'Close current window' },
        { command: 'lang', description: t('menu.lang_desc') },
        { command: 'cmd', description: t('menu.cmd_desc') },
        { command: 'file', description: t('menu.file_desc') },
        { command: 'stop', description: t('menu.stop_desc') },
        { command: 'autoaccept', description: t('menu.autoaccept_desc') },
        { command: 'quota', description: t('menu.quota_desc') },
        { command: 'update', description: t('menu.update_desc') || 'Check for updates' },
        { command: 'version', description: t('menu.version_desc') || 'Show current version' },
        { command: 'menu', description: t('menu.menu_desc') },
        { command: 'app', description: t('menu.app_desc') || 'Select active application' },
        { command: 'fix_shortcuts', description: t('menu.fix_shortcuts_desc') || 'Fix desktop shortcuts' },
        { command: 'restart', description: t('menu.restart_desc') || 'Restart the bot' },
        { command: 'goal', description: t('menu.goal_desc') || 'Set autonomous goal for agent' },
        { command: 'plan', description: t('menu.plan_desc') || 'Generate implementation plan' },
        { command: 'schedule_task', description: t('menu.schedule_task_desc') || 'Schedule a task in IDE' },
        { command: 'schedule_setup', description: t('schedule.menu_schedule_setup_desc') || 'Setup CronCrew connection' },
        { command: 'schedule_list', description: t('schedule.menu_schedule_list_desc') || 'List scheduled tasks' },
        { command: 'schedule_add', description: t('schedule.menu_schedule_add_desc') || 'Add a new schedule' },
        { command: 'schedule_status', description: t('schedule.menu_schedule_status_desc') || 'Show CronCrew status' }
    ];
    return cmds.sort((a, b) => a.command.localeCompare(b.command));
}

/**
 * Delete commands from ALL Telegram scopes and language codes
 * to prevent stale entries from overriding the default menu.
 */
async function clearAllMenuScopes() {
    const scopes = [
        { type: 'default' },
        { type: 'all_private_chats' },
        { type: 'all_group_chats' },
        { type: 'all_chat_administrators' }
    ];
    const langs = ['', 'en', 'tr'];
    
    for (const scope of scopes) {
        for (const lang of langs) {
            try {
                const params = { scope };
                if (lang) params.language_code = lang;
                await bot.telegram.callApi('deleteMyCommands', params);
            } catch (_) {}
        }
    }
    
    // Also clear chat-specific scope if ALLOWED_CHAT_IDS is set
    for (const chat_id of ALLOWED_CHAT_IDS) {
        for (const lang of langs) {
            try {
                const params = { scope: { type: 'chat', chat_id: parseInt(chat_id) } };
                if (lang) params.language_code = lang;
                await bot.telegram.callApi('deleteMyCommands', params);
            } catch (_) {}
        }
    }
}

/**
 * Set commands on all relevant scopes, utilizing Telegram's native localized menus.
 * We register menus for all available languages ('en', 'tr') plus the default.
 */
async function setMenuOnAllScopes() {
    const langs = fs.readdirSync(path.join(__dirname, '..', 'locales'))
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''));
    const defaultLang = process.env.LANGUAGE || 'en';
    const originalLang = getLang(); // Save the user's active language

    // Helper to register commands for a specific language and scope
    const register = async (langCode) => {
        // Temporarily load this locale to generate translated commands
        loadLocale(langCode);
        const cmds = getMenuCommands();
        
        const paramsDefault = { commands: cmds };
        const paramsPrivate = { commands: cmds, scope: { type: 'all_private_chats' } };
        
        // If it's not the default fallback, specify the language_code so Telegram routes it natively
        if (langCode !== defaultLang) {
            paramsDefault.language_code = langCode;
            paramsPrivate.language_code = langCode;
        }

        await bot.telegram.callApi('setMyCommands', paramsDefault).catch(()=>{});
        await bot.telegram.callApi('setMyCommands', paramsPrivate).catch(()=>{});

        if (langCode === originalLang) {
            for (const chat_id of ALLOWED_CHAT_IDS) {
                const paramsChat = { 
                    commands: cmds, 
                    scope: { type: 'chat', chat_id: parseInt(chat_id) } 
                };
                await bot.telegram.callApi('setMyCommands', paramsChat).catch(()=>{});
            }
        }
    };

    // 1. Register the non-default languages (e.g. 'en')
    for (const l of langs) {
        if (l !== defaultLang) await register(l);
    }
    // 2. Register the default fallback language last (no language_code)
    await register(defaultLang);
    
    // 3. Restore the original active language
    loadLocale(originalLang);
}

bot.command('menu', async (ctx) => {
    await clearAllMenuScopes();
    await setMenuOnAllScopes();
    await sendMainMenu(ctx, t('menu.updated'));
});

// ===== UPDATE & VERSION =====

bot.command('version', async (ctx) => {
    const local = updater.getLocalVersion();
    ctx.reply(
        `📦 <b>Antigravity Telegram Suite</b>\n\n` +
        `Version: <code>v${local.version}</code>\n` +
        `Commit: <code>${local.commitHash}</code>`,
        { parse_mode: 'HTML' }
    );
});

bot.command('update', async (ctx) => {
    ctx.reply(t('update.checking'));
    try {
        const result = await updater.checkForUpdates();
        if (!result.available) {
            ctx.reply(
                t('update.up_to_date', { version: result.localVersion, commit: result.localCommit }),
                { parse_mode: 'HTML' }
            );
            return;
        }
        await ctx.reply(
            t('update.available') +
            t('update.current_version', { version: result.localVersion, commit: result.localCommit }) +
            t('update.new_version_info', { version: result.remoteVersion, commit: result.remoteCommit }) +
            (result.remoteCommitMessage ? t('update.changelog', { message: result.remoteCommitMessage }) : `\n`) +
            t('update.update_note') +
            t('update.updating'),
            { parse_mode: 'HTML' }
        );
        const updateResult = await updater.performUpdate();
        await ctx.reply(`ℹ️ ${updateResult.message}`);
    } catch(e) {
        ctx.reply(t('update.error', { error: e.message }));
    }
});

// ===== TURBO / COUNCIL MODE =====

async function handleTurbo(ctx) {
    if (typeof currentEngine !== 'undefined' && currentEngine === 'claude') {
        return ctx.reply(t('feature.claude_unsupported') || '❌ This feature is currently only available in Antigravity mode.');
    }
    isTurboMode = !isTurboMode; // Toggle
    
    if (!isTurboMode) {
        if (turboPinnedMsgId) {
            try {
                await ctx.telegram.unpinChatMessage(ctx.chat.id, turboPinnedMsgId);
            } catch (e) {}
            turboPinnedMsgId = null;
        }
        saveTurboState();
        await sendMainMenu(ctx, t('turbo.off'));
    } else {
        const msg = await ctx.reply(
            t('turbo.on_msg'), 
            { parse_mode: 'HTML' }
        );
        turboPinnedMsgId = msg.message_id;
        try {
            await ctx.telegram.pinChatMessage(ctx.chat.id, turboPinnedMsgId);
        } catch (e) {}
        saveTurboState();
        await sendMainMenu(ctx, t('turbo.on_toast') || '🚀 Turbo Mod devrede!');
    }
}

bot.command('turbo', handleTurbo);
bot.hears(/^🚀/i, handleTurbo);

bot.action('turbo_force_stop', async (ctx) => {
    isTurboRunning = false;
    isTurboMode = false;
    saveTurboState();
    try { stopAgent(CDP_PORT); } catch(e) {}
    await ctx.editMessageText('🛑 Turbo Mode has been force stopped. You can now send your message.').catch(() => {});
});

bot.action('turbo_cancel', async (ctx) => {
    await ctx.deleteMessage().catch(() => {});
});

// ===== TEXT MESSAGE HANDLER (Headless mode) =====

bot.command('panel', async (ctx) => {
    await sendMainMenu(ctx);
});

bot.hears(/^🤖/i, async (ctx) => {
    if (typeof currentEngine !== 'undefined' && currentEngine === 'claude') return;
    const preferredApp = process.env.ANTIGRAVITY_PREFERRED_APP || 'agent';
    const isIDE = preferredApp === 'ide';
    
    if (isIDE) {
        // ide modunda bu buton workspace adını gösteriyor, bu yüzden workspace menüsünü aç
        ctx.message.text = '/workspace';
        return handleWorkspace(ctx);
    }
    
    // 🤖 butonu aktif ajanı gösteriyor — tıklanınca /agents listesini tetikle
    try {
        const workspaces = await listAgentThreads(CDP_PORT);
        if (workspaces.length === 0) {
            return ctx.reply(t('agents.no_recent') || 'ℹ️ No recent active threads found.');
        }
        
        cachedAgentThreads = [];
        let msg = t('agents.list_title') || '📂 <b>Recent Chat Threads:</b>\n\n';
        let index = 1;
        
        for (const ws of workspaces) {
            const recentThreads = ws.threads.filter(th => {
                if (/^show\s+\d+\s+more/i.test(th.name)) return false;
                return true;
            });
            
            if (recentThreads.length > 0) {
                msg += `<b>📁 ${ws.workspace}</b>\n`;
                for (const th of recentThreads) {
                    cachedAgentThreads.push({ ...th, workspace: ws.workspace });
                    msg += `  /agents_${index} - ${th.name} <i>(${th.time})</i>\n`;
                    index++;
                }
                msg += '\n';
            }
        }
        
        if (cachedAgentThreads.length === 0) {
            return ctx.reply(t('agents.no_recent') || 'ℹ️ No recent active threads found.');
        }
        
        ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (e) {
        ctx.reply((t('agents.error') || '❌ Error: ') + e.message);
    }
});
bot.hears(/^🧠/i, handleModel);

function extractQuotedContext(ctx) {
    if (!ctx.message.reply_to_message) return "";
    const msg = ctx.message.reply_to_message;
    let quotedText = msg.text || msg.caption || "";
    if (!quotedText) return "";
    
    quotedText = quotedText.replace(/✅ Completed!/g, '');
    quotedText = quotedText.replace(/📁[^\n]+/g, '');
    quotedText = quotedText.replace(/🤖[^\n]+/g, '');
    const swipeText = t('agent.swipe_to_reply').replace(/<[^>]+>/g, '');
    if (swipeText) {
        quotedText = quotedText.replace(new RegExp(swipeText.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'gi'), '');
    }
    quotedText = quotedText.replace(/🤖 Agent:/g, '');
    quotedText = quotedText.trim();
    
    if (quotedText.length > 500) {
        quotedText = quotedText.substring(0, 500) + '...';
    }
    
    return quotedText ? `[Replying to Agent's message: "${quotedText}"]\n\n` : "";
}


// ===== INTERACTIVE MODAL ANSWER HANDLER =====
bot.action(/^ans_(.+)$/, async (ctx) => {
    const answer = ctx.match[1];
    await ctx.answerCbQuery(t('interactive_modal.answer_sent', { answer }));
    
    let targetId = getPreferredTargetId();
    let explicitThreadName = null;
    if (ctx.callbackQuery.message) {
        const val = messageTargetMap.get(ctx.callbackQuery.message.message_id);
        if (typeof val === 'string') targetId = val;
        else if (val) { targetId = val.targetId; explicitThreadName = val.threadName; }
    }
    
    try {
        if (explicitThreadName) await switchAgentThread(CDP_PORT, explicitThreadName).catch(()=>{});
        setReaction(ctx, REACTION.THINKING, ctx.callbackQuery.message?.message_id);
        targetId = await sendViaCDP(answer, CDP_PORT, targetId);
        
        await new Promise(r => setTimeout(r, 1500));
        await snapshotChatState(CDP_PORT, targetId).catch(() => {});

        const isDone = await waitForAgentResponse(CDP_PORT, 450000, createProgressHandler(ctx), targetId);
        let text = "";
        let interactiveButtons = null;
        if (isDone) {
            let _latestRes = await getFullLatestResponse(CDP_PORT, targetId, explicitThreadName);
            text = typeof _latestRes === 'string' ? _latestRes : _latestRes.text;
            interactiveButtons = typeof _latestRes === 'string' ? null : _latestRes.buttons;
            text = stripQueryFromResponse(text, answer);
        } else {
            return await ctx.reply(t('ask.timeout'));
        }
        
        if (!text) text = t('ask.done_empty');
        const header = await getChatHeader(targetId, t('ask.done'));
        const buttons = interactiveButtons ? interactiveButtons : await buildMainMenu(null, null, targetId);

        const sentIds = await sendLongMessage(ctx, text, header, buttons, ctx.callbackQuery.message.message_id);
        if (sentIds && sentIds.length > 0 && targetId) {
            const activeInfo = await getActiveThreadInfo(CDP_PORT, targetId).catch(() => null);
            const currentThreadName = activeInfo ? activeInfo.name : null;
            sentIds.forEach(id => messageTargetMap.set(id, { targetId, threadName: currentThreadName }));
            saveMessageTargetMap(messageTargetMap);
        }
    } catch (e) {
        ctx.reply(t('error.general_error', { error: e.message })).catch(()=>{});
    }
});

async function handleAgentQuery(ctx, query, explicitTargetId = null, explicitThreadName = null) {
    // ---- CLAUDE CODE ENGINE ----
    if (currentEngine === 'claude') {
        return handleClaudeQuery(ctx, query);
    }
    // ---- ANTIGRAVITY ENGINE (existing) ----
    try {
        if (explicitThreadName) await switchAgentThread(CDP_PORT, explicitThreadName).catch(()=>{});
        let targetId = explicitTargetId;
        let text = "";
        let interactiveButtons = null;

        if (isTurboMode) {
            isTurboRunning = true;
            try {
                const turboTargetId = explicitTargetId || getPreferredTargetId() || null;
                text = await runTurboOrchestration(query, CDP_PORT, turboTargetId, ctx, createProgressHandler, stripQueryFromResponse);
                targetId = turboTargetId;
            } finally {
                isTurboRunning = false;
            }
        } else {
            targetId = await sendViaCDPWithRecovery(query, explicitTargetId);
            setReaction(ctx, REACTION.THINKING);

            // Wait briefly for message to render in DOM before anchoring state
            await new Promise(r => setTimeout(r, 1500));
            await snapshotChatState(CDP_PORT, targetId).catch(() => {});
            
            // Mark TaskWatcher as busy during agent response wait
            if (global.__taskWatcher) global.__taskWatcher.setBusy(true);
            try {
                const isDone = await waitForAgentResponse(CDP_PORT, 450000, createProgressHandler(ctx), targetId);
                if (isDone) {
                    let _latestRes = await getFullLatestResponse(CDP_PORT, targetId, explicitThreadName);
                    text = typeof _latestRes === 'string' ? _latestRes : _latestRes.text;
                    interactiveButtons = typeof _latestRes === 'string' ? null : _latestRes.buttons;
                    
                    text = stripQueryFromResponse(text, query);
                } else {
                    return await ctx.reply(t('ask.timeout'));
                }
            } finally {
                if (global.__taskWatcher) global.__taskWatcher.setBusy(false);
            }
        }

        if (!text) text = t('ask.done_empty');
        const header = await getChatHeader(targetId, t('ask.done'));
        const buttons = interactiveButtons ? interactiveButtons : await buildMainMenu(null, null, targetId);
        
        const sentIds = await sendLongMessage(ctx, text, header, buttons, ctx.message.message_id);
        if (sentIds && sentIds.length > 0 && targetId) {
            const activeInfo = await getActiveThreadInfo(CDP_PORT, targetId).catch(() => null);
            const currentThreadName = activeInfo ? activeInfo.name : null;
            sentIds.forEach(id => messageTargetMap.set(id, { targetId, threadName: currentThreadName }));
            saveMessageTargetMap(messageTargetMap);
        }
    } catch(err) {
        const errorMsg = err.message === 'no_chat_input' ? t('ask.no_chat_input') : err.message;
        ctx.reply(t('ask.headless_error', { error: errorMsg })).catch(() => {});
    }
}

// Prefix '!' handler for invoking Antigravity skills
bot.hears(/^!([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/, async (ctx) => {
    const skillName = ctx.match[1];
    const skillArgs = ctx.match[2] ? ctx.match[2].trim() : '';
    const query = `/${skillName} ${skillArgs}`.trim();
    
    let explicitTargetId = null;
    let explicitThreadName = null;
    let explicitClaudeSessionId = null;
    if (ctx.message.reply_to_message) {
        const val = messageTargetMap.get(ctx.message.reply_to_message.message_id);
        if (typeof val === 'string') explicitTargetId = val;
        else if (val) { 
            explicitTargetId = val.targetId; 
            explicitThreadName = val.threadName;
            explicitClaudeSessionId = val.claudeSessionId;
        }
    }
    if (!explicitTargetId && ctx.message.reply_to_message?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('focus_')) {
        explicitTargetId = ctx.message.reply_to_message.reply_markup.inline_keyboard[0][0].callback_data.replace('focus_', '');
    }

    if (typeof currentEngine !== 'undefined' && currentEngine === 'claude') {
        if (explicitClaudeSessionId) setActiveSession(String(ctx.chat.id), explicitClaudeSessionId);
        return handleClaudeQuery(ctx, query, explicitClaudeSessionId).catch(() => {});
    }
    
    await handleAgentQuery(ctx, query, explicitTargetId, explicitThreadName);
});

bot.on('text', (ctx) => {
    if (ctx.message.text.startsWith('/') || ctx.message.text.startsWith('!')) return;

    // ---- BRAIN2 CRON REPLY detection ----
    if (ctx.message.reply_to_message) {
        const cronInfo = isCronReply(ctx.message.reply_to_message.message_id);
        if (cronInfo) {
            // Route to An with fresh context (new chat + injected prompt)
            const contextQuery = buildCronContext(cronInfo, ctx.message.text);
            console.log(`[Brain2Cron] Reply detected for ${cronInfo.jobId} — opening new chat`);
            (async () => {
                try {
                    await triggerNewChat(CDP_PORT);
                    await new Promise(r => setTimeout(r, 1500));
                    await handleAgentQuery(ctx, contextQuery, null, null);
                } catch (e) {
                    console.error('[Brain2Cron] Reply handling failed:', e.message);
                    ctx.reply('⚠️ Xử lý reply thất bại: ' + e.message);
                }
            })();
            return;
        }
    }

    let query = ctx.message.text;
    let explicitTargetId = null;
    let explicitThreadName = null;
    let explicitClaudeSessionId = null;

    if (ctx.message.reply_to_message) {
        const val = messageTargetMap.get(ctx.message.reply_to_message.message_id);
        if (typeof val === 'string') explicitTargetId = val;
        else if (val) { 
            explicitTargetId = val.targetId; 
            explicitThreadName = val.threadName;
            explicitClaudeSessionId = val.claudeSessionId;
        }
        
        query = extractQuotedContext(ctx) + query;
    }
    if (!explicitTargetId && ctx.message.reply_to_message?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('focus_')) {
        explicitTargetId = ctx.message.reply_to_message.reply_markup.inline_keyboard[0][0].callback_data.replace('focus_', '');
    }

    // ---- CLAUDE CODE routing ----
    if (currentEngine === 'claude') {
        if (explicitClaudeSessionId) setActiveSession(String(ctx.chat.id), explicitClaudeSessionId);
        return handleClaudeQuery(ctx, query, explicitClaudeSessionId).catch(() => {});
    }

    // ---- ANTIGRAVITY routing (existing) ----
    handleAgentQuery(ctx, query, explicitTargetId, explicitThreadName).catch(()=>{});
});

// ===== PHOTO & DOCUMENT HANDLER =====

const mediaGroupCache = new Map();

async function processAgentRequest(ctx, query, explicitTargetId, explicitThreadName, originalCaption) {
    setReaction(ctx, REACTION.THINKING);
    if (explicitThreadName) await switchAgentThread(CDP_PORT, explicitThreadName).catch(()=>{});
    const targetId = await sendViaCDP(query, CDP_PORT, explicitTargetId);
    
    if (targetId === "INVALID_MODAL_OPTION") {
        ctx.reply("❌ Şu anda aktif bir soru paneli (modal) açık. Lütfen seçeneklerden birini girin veya iptal etmek için /stop komutunu kullanın. (Görsel veya serbest metin bu soru için geçerli değil)");
        return;
    }

    // Wait briefly for message to render in DOM before anchoring state
    await new Promise(r => setTimeout(r, 1500));
    await snapshotChatState(CDP_PORT, targetId).catch(() => {});
    
    const isDone = await waitForAgentResponse(CDP_PORT, 450000, createProgressHandler(ctx), targetId);
    if (isDone) {
        let _latestRes = await getFullLatestResponse(CDP_PORT, targetId);
        let text = typeof _latestRes === 'string' ? _latestRes : _latestRes.text;
        let interactiveButtons = typeof _latestRes === 'string' ? null : _latestRes.buttons;
        
        text = stripQueryFromResponse(text, query);
        if (originalCaption) {
            text = stripQueryFromResponse(text, originalCaption);
        }
        if (!text) text = t('ask.done_empty');
        const header = await getChatHeader(targetId, t('ask.done'));
        
        const buttons = interactiveButtons ? interactiveButtons : await buildMainMenu(null, null, targetId);
        
        const sentIds = await sendLongMessage(ctx, text, header, buttons, ctx.message.message_id);
        if (sentIds && sentIds.length > 0 && targetId) {
            const activeInfo = await getActiveThreadInfo(CDP_PORT, targetId).catch(() => null);
            const currentThreadName = activeInfo ? activeInfo.name : null;
            sentIds.forEach(id => messageTargetMap.set(id, { targetId, threadName: currentThreadName }));
            saveMessageTargetMap(messageTargetMap);
        }
    } else {
        await ctx.reply(t('ask.timeout'));
    }
}

async function processMediaGroup(group) {
    const ctx = group.ctx;
    const paths = group.files.map(p => `\`${p}\``).join(', ');
    const combinedCaption = group.captions.join('\n');
    
    const query = `[System: The user has uploaded ${group.files.length} files. You MUST use your \`view_file\` tool to examine ALL files at these absolute paths: ${paths} . Do not say you cannot see them. Use the tool!]${combinedCaption ? `\nUser's message: ${combinedCaption}` : ''}`;
    
    try {
        await processAgentRequest(ctx, query, group.explicitTargetId, group.explicitThreadName, combinedCaption);
    } catch(err) {
        const errorMsg = err.message === 'no_chat_input' ? t('ask.no_chat_input') : err.message;
        ctx.reply(t('photo.error', { error: errorMsg })).catch(() => {});
    }
}

bot.on(['photo', 'document'], (ctx) => {
    (async () => {
        try {
            if (ctx.message.document) {
                const mime = ctx.message.document.mime_type || '';
                const fname = (ctx.message.document.file_name || '').toLowerCase();
                if (mime.startsWith('audio/') || fname.endsWith('.m4a') || fname.endsWith('.mp3') || fname.endsWith('.wav') || fname.endsWith('.ogg')) {
                    return handleAudioTranscription(ctx, ctx.message.document.file_id);
                }
            }
            let fileId;
            let fileName = "telegram_upload";
            
            if (ctx.message.photo) {
                const photos = ctx.message.photo;
                fileId = photos[photos.length - 1].file_id;
                fileName += ".jpg";
            } else if (ctx.message.document) {
                fileId = ctx.message.document.file_id;
                fileName = ctx.message.document.file_name || "telegram_upload.file";
            }
            
            const fileLink = await ctx.telegram.getFileLink(fileId);
            const https = require('https');
            const dest = path.join(config.tempDir, `tg_${Date.now()}_${fileName}`);
            
            await new Promise((resolve, reject) => {
                const file = fs.createWriteStream(dest);
                https.get(fileLink, function(response) {
                    response.pipe(file);
                    file.on('finish', function() {
                        file.close(resolve);
                    });
                }).on('error', function(err) {
                    fs.unlink(dest, () => {});
                    reject(err);
                });
            });
            
            let caption = ctx.message.caption ? ctx.message.caption : "";
            
            // --- BẮT ĐẦU CHÈN LOGIC FINANCE ---
            if (caption.includes('#bill') || caption.includes('/tuvan') || caption.includes('#finance')) {
                ctx.reply('Đang nhờ Gemini OCR phân tích hóa đơn tài chính...');
                try {
                    const cards = await getCreditCards();
                    const cardNames = cards.map((c) => c.name);
                    const fs = require('fs');
                    const base64Image = fs.readFileSync(dest, {encoding: 'base64'});
                    
                    const data = await extractFinancialInfo(caption, 'image/jpeg', base64Image, cardNames);
                    
                    if (data.type === 'STATEMENT') {
                      const card = cards.find((c) => c.name === data.card_name);
                      if (!card) {
                        ctx.reply(`❌ Lỗi: Nhận diện được thẻ "${data.card_name}" nhưng không có trong Database.`);
                      } else {
                        let statementMonth = new Date();
                        if (data.due_date) {
                          const parts = data.due_date.split('/');
                          if (parts.length === 3) statementMonth = new Date(`${parts[2]}-${parts[1]}-01`);
                        }
                        await updateBillingStatement({
                          card_id: card.id,
                          statement_month: statementMonth.toISOString().split('T')[0],
                          total_debt: data.total_debt,
                          minimum_payment: data.minimum_payment
                        });
                        ctx.reply(`✅ Đã lưu Sao Kê:\nThẻ: ${data.card_name}\nDư nợ: ${data.total_debt.toLocaleString()} VND\nTT tối thiểu: ${data.minimum_payment.toLocaleString()} VND\nHạn chót: ${data.due_date}\n\nĐã lưu vào Supabase và đặt lịch nhắc nhở!`);
                      }
                    } else if (data.type === 'TRANSACTION') {
                      const card = cards.find((c) => c.name === data.card_name);
                      if (!card) {
                        ctx.reply(`❌ Lỗi: Nhận diện được thẻ "${data.card_name}" nhưng không có trong Database.`);
                      } else {
                        let transDate = new Date();
                        if (data.transaction_date) {
                          const parts = data.transaction_date.split(' ');
                          const dateParts = parts[0].split('/');
                          const timeParts = parts[1] ? parts[1].split(':') : ['00', '00'];
                          transDate = new Date(`${dateParts[2]}-${dateParts[1]}-${dateParts[0]}T${timeParts[0]}:${timeParts[1]}:00+07:00`);
                        }
                        try {
                          await addTransaction({
                            card_id: card.id,
                            transaction_date: transDate.toISOString(),
                            amount: data.amount,
                            description: data.description,
                            cashback_earned: 0,
                            is_online: data.is_online
                          });
                          const onlineStr = data.is_online ? "🌐 Thanh toán Online (Được tính Cashback)" : "🏪 Quẹt Offline (Không được tính Cashback)";
                          ctx.reply(`✅ Đã lưu Giao Dịch:\nThẻ: ${data.card_name}\nSố tiền: ${data.amount.toLocaleString()} VND\nNội dung: ${data.description}\nLoại: ${onlineStr}\n\nĐã cập nhật lên hệ thống Brain2!`);
                        } catch (err) {
                          if (err.message === "DUPLICATE_TRANSACTION") {
                            ctx.reply(`⚠️ Bỏ qua Giao Dịch:\nThẻ: ${data.card_name} | Số tiền: ${data.amount} VND.\nGiao dịch này ĐÃ TỒN TẠI trong hệ thống (chống trùng lặp).`);
                          } else throw err;
                        }
                      }
                    } else {
                      ctx.reply(`❌ Không nhận diện được dữ liệu tài chính trong ảnh. Thử lại nhé anh.`);
                    }
                    fs.unlinkSync(dest); // Xóa file rác
                    return; // Kết thúc không gửi cho IDE Agent
                } catch (err) {
                    console.error("Finance OCR Error:", err);
                    ctx.reply("Có lỗi khi xử lý hóa đơn tài chính.");
                    return;
                }
            }
            // --- KẾT THÚC CHÈN LOGIC FINANCE ---

            let explicitTargetId = null;
            let explicitThreadName = null;
            let quotedContext = "";
            if (ctx.message.reply_to_message) {
                const val = messageTargetMap.get(ctx.message.reply_to_message.message_id);
                if (typeof val === 'string') explicitTargetId = val;
                else if (val) { explicitTargetId = val.targetId; explicitThreadName = val.threadName; }
                
                quotedContext = extractQuotedContext(ctx);
            }
            if (!explicitTargetId && ctx.message.reply_to_message?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('focus_')) {
                explicitTargetId = ctx.message.reply_to_message.reply_markup.inline_keyboard[0][0].callback_data.replace('focus_', '');
            }
            
            if (quotedContext) {
                caption = caption ? quotedContext + caption : quotedContext.trim();
            }
            
            const mediaGroupId = ctx.message.media_group_id;
            if (mediaGroupId) {
                if (!mediaGroupCache.has(mediaGroupId)) {
                    mediaGroupCache.set(mediaGroupId, {
                        files: [],
                        captions: [],
                        timer: null,
                        ctx: ctx,
                        explicitTargetId,
                        explicitThreadName
                    });
                }
                const group = mediaGroupCache.get(mediaGroupId);
                group.files.push(dest);
                if (caption) group.captions.push(caption);
                
                clearTimeout(group.timer);
                group.timer = setTimeout(() => {
                    mediaGroupCache.delete(mediaGroupId);
                    processMediaGroup(group);
                }, 1500);
                return;
            }
            
            const query = `[System: The user has uploaded an image or file. You MUST use your \`view_file\` tool to examine the file at this absolute path: ${dest} . Do not say you cannot see it. Use the tool!]${caption ? `\nUser's message: ${caption}` : ''}`;
            
            await processAgentRequest(ctx, query, explicitTargetId, explicitThreadName, caption);
            
        } catch(err) {
            const errorMsg = err.message === 'no_chat_input' ? t('ask.no_chat_input') : err.message;
            ctx.reply(t('photo.error', { error: errorMsg })).catch(() => {});
        }
    })();
});


// ===== AUDIO/VOICE TRANSCRIPTION (WHISPER.CPP) =====
async function handleAudioTranscription(ctx, fileId) {

        try {
            const msg = await ctx.reply('🎧 Đang tải và giải mã âm thanh (Local AI)...');
            
            
            const link = await ctx.telegram.getFileLink(fileId);
            
            const tmpAudio = path.join(os.tmpdir(), `voice_${Date.now()}.ogg`);
            const tmpWav = path.join(os.tmpdir(), `voice_${Date.now()}.wav`);
            
            // Download file
            const https = require('https');
            await new Promise((resolve, reject) => {
                const file = fs.createWriteStream(tmpAudio);
                https.get(link.href, function(response) {
                    if (response.statusCode !== 200) {
                        return reject(new Error(`HTTP error! status: ${response.statusCode}`));
                    }
                    response.pipe(file);
                    file.on('finish', function() {
                        file.close(resolve);
                    });
                }).on('error', function(err) {
                    fs.unlink(tmpAudio, () => {});
                    reject(err);
                });
            });
            
            // Convert to WAV
            await new Promise((resolve, reject) => {
                exec(`/opt/homebrew/bin/ffmpeg -i ${tmpAudio} -ar 16000 -ac 1 -c:a pcm_s16le ${tmpWav} -y`, (err) => {
                    if (err) reject(err); else resolve();
                });
            });
            
            // Run Whisper
            const modelPath = path.join(__dirname, '..', 'models', 'ggml-base.bin');
            if (!fs.existsSync(modelPath)) {
                throw new Error("Whisper model not found at " + modelPath);
            }
            
            const whisperResult = await new Promise((resolve, reject) => {
                exec(`/opt/homebrew/bin/whisper-cli -m ${modelPath} -f ${tmpWav} -l vi -nt`, (err, stdout) => {
                    if (err) reject(err); else resolve(stdout);
                });
            });
            
            let text = whisperResult.trim();
            // Fallback parsing if -nt doesn't work perfectly (remove timestamps)
            text = text.replace(/\[\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\]\s*/g, '').trim();
            
            // Clean up Vietnamese dictation for exclamation mark skills
            // Matches: "chấm than reflect", "chấm thân rì phleg", "chấm cảm", etc.
            text = text.replace(/^(chấm than|chấm thân|chấm cảm|trống than)[\s,]+(rì phleg|rì phờ lếch|reflect)/i, '!reflect ');
            text = text.replace(/^(chấm than|chấm thân|chấm cảm|trống than)[\s,]+(craw|cờ ro)/i, '!craw ');
            text = text.replace(/^(chấm than|chấm thân|chấm cảm|trống than)[\s,]+([a-zA-Z]+)/i, '!$2 ');
            
            if (!text) throw new Error("Could not transcribe voice.");
            
            await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `🎤 <b>Đã giải mã:</b>\n<i>${text}</i>`, { parse_mode: 'HTML' }).catch(()=>{});
            
            let query = text;
            
            let explicitTargetId = null;
            let explicitThreadName = null;
            if (ctx.message.reply_to_message) {
                const val = messageTargetMap.get(ctx.message.reply_to_message.message_id);
                if (typeof val === 'string') explicitTargetId = val;
                else if (val) { explicitTargetId = val.targetId; explicitThreadName = val.threadName; }
            }
            if (!explicitTargetId && ctx.message.reply_to_message?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('focus_')) {
                explicitTargetId = ctx.message.reply_to_message.reply_markup.inline_keyboard[0][0].callback_data.replace('focus_', '');
            }
            
            if (query.startsWith('!')) {
                 const match = query.match(/^!([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
                 if (match) {
                     const skillName = match[1];
                     const skillArgs = match[2] ? match[2].trim() : '';
                     query = `/${skillName} ${skillArgs}`.trim();
                 }
            } else if (!query.startsWith('/')) {
                 query = "🎤 [Voice]: " + query;
            }
            
            await handleAgentQuery(ctx, query, explicitTargetId, explicitThreadName);
            
            // Cleanup
            fs.unlinkSync(tmpAudio);
            fs.unlinkSync(tmpWav);
            
        } catch(err) {
            console.error('Voice Error:', err);
            const errorMsg = err.message === 'no_chat_input' ? t('ask.no_chat_input') : err.message;
            ctx.reply('❌ Lỗi xử lý âm thanh: ' + errorMsg).catch(() => {});
        }
    
}

bot.on('voice', async (ctx) => {
    await handleAudioTranscription(ctx, ctx.message.voice.file_id);
});

bot.on('audio', async (ctx) => {
    await handleAudioTranscription(ctx, ctx.message.audio.file_id);
});


// ===== LAUNCH =====

async function init() {
    console.log("Starting initialization...");
    try {
        await clearAllMenuScopes();
        await setMenuOnAllScopes();
        console.log("Menu commands set.");
    } catch(e) {
        console.error("Could not set commands", e.message);
    }
    
    // Auto-accept defaults to false, unless explicitly enabled by env
    if (process.env.AUTOACCEPT_DEFAULT === 'true') {
        console.log('[autoaccept] Auto-starting (AUTOACCEPT_DEFAULT=true)...');
        autoaccept.enable(CDP_PORT).then(r => {
            console.log(`[autoaccept] Auto-start result: injected=${r.injected}`);
        }).catch(e => {
            console.log(`[autoaccept] Auto-start failed: ${e.message} (will retry via heartbeat)`);
        });
    } else {
        console.log('[autoaccept] Disabled by default. Use /autoaccept on to enable.');
    }

    console.log(t('bot.polling'));
    
    bot.catch((err, ctx) => {
        console.error(`[Bot Error] for ${ctx.updateType}:`, err.message || err);
    });

    // Check if this boot is after an explicit /restart command.
    // If so, drop pending updates to prevent the /restart from being re-processed (infinite loop).
    let shouldDropPending = false;
    try {
        if (fs.existsSync(RESTART_FLAG_FILE)) {
            shouldDropPending = true;
            fs.unlinkSync(RESTART_FLAG_FILE);
            console.log('[init] Restart flag detected — dropping pending updates to prevent /restart loop');
        }
    } catch (_) {}

    const launchBot = () => {
        bot.launch({ dropPendingUpdates: shouldDropPending }).catch(err => {
            console.error("Bot launch failed:", err.message || err);
            console.log("Retrying in 30 seconds...");
            setTimeout(launchBot, 30000);
        });
    };
    launchBot();

    // Push the main menu keyboard to the user so it's active by default (wait 3s to let IDE/CDP initialize)
    setTimeout(() => {
        const updateFlagPath = path.join(__dirname, '..', '.update_flag');
        if (fs.existsSync(updateFlagPath)) {
            const startupMsg = t('update.bot_updated');
            pushMainMenuToUser(startupMsg).catch(console.error);
            try { fs.unlinkSync(updateFlagPath); } catch (e) {}
        } else {
            // Sadece sessizce menüyü güncelle
            pushMainMenuToUser(t('bot.restarted'), true).catch(console.error);
        }
    }, 3000);

    // Start periodic update checker (notifies via Telegram when update is available)
    updater.startUpdateChecker(bot, ALLOWED_CHAT_IDS);

    // Initialize Task Watcher — monitors agent's proactive notifications
    const preferredApp = (process.env.ANTIGRAVITY_PREFERRED_APP || 'ide').toLowerCase();
    const appDataName = preferredApp === 'agent' ? 'antigravity' : 'antigravity-ide';
    
    // Track last proactive notification message per chat for edit-in-place
    const proactiveMessageIds = new Map(); // chatId -> { messageId, timestamp }
    const PROACTIVE_RESET_MS = 5 * 60 * 1000; // Reset after 5 min of silence

    const taskWatcher = new TaskWatcher({
        appDataName,
        onNotification: async ({ conversationId, text, type }) => {
            console.log(`[TaskWatcher] 📬 Proactive notification (${type}, conv: ${conversationId?.substring(0, 8)}, ${text.length} chars)`);

            const header = '🔔 <b>' + t('task_watcher.proactive_msg') + '</b>\n\n';
            // Truncate for Telegram 4096 char limit
            const maxLen = 4096 - header.length - 10;
            const body = text.length > maxLen ? text.substring(0, maxLen) + '…' : text;
            const fullMsg = header + body;

            for (const chatId of ALLOWED_CHAT_IDS) {
                try {
                    const existing = proactiveMessageIds.get(chatId);
                    const now = Date.now();

                    // If we have a recent message, try to edit it
                    if (existing && (now - existing.timestamp) < PROACTIVE_RESET_MS) {
                        try {
                            await bot.telegram.editMessageText(
                                chatId, existing.messageId, null,
                                fullMsg, { parse_mode: 'HTML' }
                            );
                            existing.timestamp = now;
                            console.log(`[TaskWatcher] Edited existing notification msg ${existing.messageId}`);
                            continue;
                        } catch (editErr) {
                            // Edit failed (message too old, deleted, or content unchanged)
                            console.log(`[TaskWatcher] Edit failed, sending new: ${editErr.message}`);
                        }
                    }

                    // Send a new message
                    try {
                        const sent = await bot.telegram.sendMessage(chatId, fullMsg, { parse_mode: 'HTML' });
                        proactiveMessageIds.set(chatId, { messageId: sent.message_id, timestamp: now });
                        console.log(`[TaskWatcher] Sent new notification msg ${sent.message_id}`);
                    } catch (err) {
                        if (err.message.includes("parse entities")) {
                            const plain = fullMsg.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
                            const sent = await bot.telegram.sendMessage(chatId, plain);
                            proactiveMessageIds.set(chatId, { messageId: sent.message_id, timestamp: now });
                            console.log(`[TaskWatcher] Sent plain text fallback ${sent.message_id}`);
                        } else {
                            throw err;
                        }
                    }
                } catch (e) {
                    console.error('[TaskWatcher] Failed to send notification:', e.message);
                }
            }
        }
    });

    // Wire thread resolution events to TaskWatcher
    setOnThreadResolved((threadId) => {
        taskWatcher.setActiveConversation(threadId);
    });

    // Expose taskWatcher globally so text handler can set busy/idle
    global.__taskWatcher = taskWatcher;
}

init();

// --- Start Heartbeat for Watchdog Agent ---
const HEARTBEAT_FILE = path.join(__dirname, '..', '.heartbeat');
function startHeartbeat() {
    const updateHeartbeat = () => {
        try {
            fs.writeFileSync(HEARTBEAT_FILE, Date.now().toString(), 'utf8');
        } catch (e) {
            console.error('[heartbeat] Failed to write heartbeat:', e.message);
        }
    };
    updateHeartbeat();
    setInterval(updateHeartbeat, 30000); // update every 30 seconds
}
startHeartbeat();

// Enable graceful stop
const handleExit = async (signal) => {
    console.log(`\nReceived ${signal}. Stopping bot polling...`);
    if (global.__taskWatcher) global.__taskWatcher.stop();
    try {
        // Fire-and-forget: bot.stop() may never resolve during long-polling,
        // but calling it triggers the internal cleanup (webhook delete, offset commit).
        // We wait a fixed delay to let the HTTP request complete.
        bot.stop(signal);
        await new Promise(r => setTimeout(r, 1500));
        console.log('Bot polling stopped cleanly.');
    } catch (_) {}
    // NOTE: We intentionally do NOT call cleanupAll() here.
    // PM2 restarts should not kill running Antigravity apps.
    // Use /restart command for explicit app cleanup.
    process.exit(0);
};


process.once('SIGINT', () => handleExit('SIGINT'));
process.once('SIGTERM', () => handleExit('SIGTERM'));
