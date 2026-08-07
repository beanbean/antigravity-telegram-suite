/**
 * cursor-controller.js
 * Headless bridge to Cursor Agent CLI (`agent` / `cursor agent`).
 * Mirrors claude-controller.js: spawn + stream-json + session resume.
 * Also manages nexmeOS vault Single Driver lock (.nexmeos-lock).
 */

const { spawn, exec, execFile } = require('child_process');
const path = require('path');
const { withVaultWriteGate } = require('./vault-write-policy');
const fs = require('fs');
const os = require('os');

const CURSOR_BIN = process.env.CURSOR_BIN || process.env.CURSOR_AGENT_BIN ||
  path.join(os.homedir(), '.local', 'bin', 'agent');
const CURSOR_TIMEOUT = parseInt(process.env.CURSOR_TIMEOUT, 10) || 900000;
const CURSOR_FORCE = process.env.CURSOR_FORCE !== 'false';
const CURSOR_SANDBOX = process.env.CURSOR_SANDBOX || ''; // 'enabled' | 'disabled' | ''
const DEFAULT_WORKSPACE = process.env.CURSOR_WORK_DIR ||
  path.join(os.homedir(), 'Projects', 'nexmeOS');

const LOCK_TTL_MS = 30 * 60 * 1000;

const AUTH_FAIL_RE = /not logged in|authentication required|invalid api.?key|unauthorized|please (run )?login|login required/i;
const AUTH_OK_RE = /login successful|logged in/i;

const AUTH_FIX_HINT =
  'Cách sửa (chọn một): (1) User chạy pm2 (`congdau`): `agent login` — session lưu qua CLI (~/.cursor/, thường macOS Keychain); ' +
  '(2) Khuyến nghị 24/7: Cursor Dashboard → User API Keys → `CURSOR_API_KEY` trong `~/telebot/.env` → `pm2 restart telebot --update-env`';

// chatId -> { sessionId, proc, lockHeld, vaultRoot }
const sessions = new Map();

function buildSpawnEnv() {
  const home = process.env.HOME || os.homedir();
  const env = {
    ...process.env,
    HOME: home,
    USER: process.env.USER || os.userInfo().username,
    NO_COLOR: '1',
  };
  if (process.env.CURSOR_API_KEY) env.CURSOR_API_KEY = process.env.CURSOR_API_KEY;
  return env;
}

function checkCursorAuth() {
  return new Promise((resolve) => {
    if (process.env.CURSOR_API_KEY) {
      return resolve({
        ok: true,
        method: 'CURSOR_API_KEY (.env)',
        summary: 'API key configured',
        hint: null,
      });
    }
    const env = buildSpawnEnv();
    exec(`"${CURSOR_BIN}" status`, { env, timeout: 15000 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}\n${stderr || ''}`.trim();
      if (!err && AUTH_OK_RE.test(out) && !AUTH_FAIL_RE.test(out)) {
        const line = out.split('\n').find((l) => AUTH_OK_RE.test(l)) || out.split('\n')[0] || 'Logged in';
        resolve({
          ok: true,
          method: 'agent login (~/.cursor/)',
          summary: line.replace(/^✓\s*/, '').trim(),
          hint: null,
        });
        return;
      }
      resolve({
        ok: false,
        method: 'none',
        summary: (out || err?.message || 'Not logged in').slice(0, 160),
        hint: AUTH_FIX_HINT,
      });
    });
  });
}

function formatAuthStatusHtml(auth) {
  if (!auth) return '🔐 Auth: ?';
  if (auth.ok) return `🔐 Auth: <b>OK</b> — ${auth.method}`;
  return `🔐 Auth: <b>FAIL</b>\n${auth.summary || 'Chưa login'}\n\n${auth.hint || AUTH_FIX_HINT}`;
}

function resolveVaultRoot(workDir) {
  const candidates = [
    workDir,
    path.join(os.homedir(), 'Projects', 'nexmeOS'),
    path.join(os.homedir(), 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents', 'BrainCong', 'nexmeOS'),
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      const resolved = fs.realpathSync(c);
      if (fs.existsSync(path.join(resolved, '_handoff.md'))) return resolved;
      if (fs.existsSync(path.join(resolved, '_Core', 'INSTRUCTIONS.md'))) return resolved;
    } catch (_) {}
  }
  return workDir || DEFAULT_WORKSPACE;
}

function lockPath(vaultRoot) {
  return path.join(vaultRoot, '.nexmeos-lock');
}

function parseLock(raw) {
  const out = {};
  for (const line of String(raw || '').split('\n')) {
    const m = line.match(/^([a-zA-Z_]+):\s*"?(.*?)"?\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function formatNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function lockAgeMs(info) {
  const started = info.started ? new Date(String(info.started).replace(' ', 'T')) : null;
  if (!started || Number.isNaN(started.getTime())) return 0;
  return Date.now() - started.getTime();
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin short wait for gate */ }
}

/**
 * Cross-process critical section via atomic mkdir.
 * Holds gate across stale-unlink + create so no TOCTOU window.
 */
function withLockGate(vaultRoot, fn) {
  const gate = path.join(vaultRoot, '.nexmeos-lock-gate');
  const maxAttempts = 100;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      fs.mkdirSync(gate);
      try {
        return fn();
      } finally {
        try { fs.rmdirSync(gate); } catch (_) {}
      }
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(gate);
        // Stale gate (>60s) — steal
        if (Date.now() - st.mtimeMs > 60000) {
          try { fs.rmdirSync(gate); } catch (_) {}
          continue;
        }
      } catch (_) {}
      sleepSync(20);
    }
  }
  throw new Error('lock-gate-timeout');
}

/**
 * Check vault lock. Does NOT unlink.
 */
function checkVaultLock(workDir, { ownerId } = {}) {
  const vaultRoot = resolveVaultRoot(workDir);
  const lp = lockPath(vaultRoot);
  if (!fs.existsSync(lp)) {
    return { ok: true, vaultRoot };
  }
  try {
    const raw = fs.readFileSync(lp, 'utf8');
    const info = parseLock(raw);
    const age = lockAgeMs(info);
    if (age > LOCK_TTL_MS) {
      return { ok: true, vaultRoot, stale: true, lockedBy: info.ai || 'unknown', ageMin: Math.round(age / 60000), raw };
    }
    const holder = (info.ai || '').trim() || 'unknown';
    if (ownerId && info.owner_id === ownerId) {
      return { ok: true, vaultRoot, lockedBy: holder, ownerId: info.owner_id };
    }
    return {
      ok: false,
      vaultRoot,
      lockedBy: holder,
      ageMin: Math.round(age / 60000),
      session: info.session || '',
      ownerId: info.owner_id || '',
    };
  } catch (e) {
    return { ok: true, vaultRoot };
  }
}

function sanitizeSessionLabel(label) {
  return String(label || 'telebot-cursor')
    .replace(/[\r\n"]+/g, ' ')
    .trim()
    .slice(0, 80) || 'telebot-cursor';
}

/**
 * Acquire via gate + O_EXCL. Unlink-stale and create happen under same gate (no TOCTOU).
 */
function acquireVaultLock(workDir, sessionLabel = 'telebot-cursor') {
  const vaultRoot = resolveVaultRoot(workDir);
  const lp = lockPath(vaultRoot);
  const ownerId = `cursor-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const label = sanitizeSessionLabel(sessionLabel);

  const body = [
    'ai: cursor',
    `session: "${label}"`,
    `started: "${formatNow()}"`,
    `owner_id: "${ownerId}"`,
    '',
  ].join('\n');

  try {
  return withLockGate(vaultRoot, () => {
    // Re-check under gate
    if (fs.existsSync(lp)) {
      const raw = fs.readFileSync(lp, 'utf8');
      const info = parseLock(raw);
      const age = lockAgeMs(info);
      if (age <= LOCK_TTL_MS) {
        const holder = (info.ai || '').trim() || 'unknown';
        if (!(info.owner_id && info.owner_id === ownerId)) {
          return {
            ok: false,
            vaultRoot,
            lockedBy: holder,
            ageMin: Math.round(age / 60000),
            session: info.session || '',
            ownerId: info.owner_id || '',
          };
        }
      } else {
        // Stale — safe to unlink while holding gate
        try { fs.unlinkSync(lp); } catch (_) {}
      }
    }

    try {
      const fd = fs.openSync(lp, 'wx');
      try {
        fs.writeFileSync(fd, body, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, vaultRoot, acquired: true, ownerId };
    } catch (e) {
      return {
        ok: false,
        vaultRoot,
        lockedBy: 'cursor',
        ageMin: 0,
        session: e && e.code === 'EEXIST' ? 'lock-race' : `lock-error:${e && e.code}`,
      };
    }
  });
  } catch (e) {
    return { ok: false, vaultRoot, lockedBy: 'gate', ageMin: 0, session: e.message || 'lock-gate-timeout' };
  }
}

function releaseVaultLock(workDir, ownerId = null) {
  const vaultRoot = resolveVaultRoot(workDir);
  const lp = lockPath(vaultRoot);
  try {
    return withLockGate(vaultRoot, () => {
      if (!fs.existsSync(lp)) return true;
      const info = parseLock(fs.readFileSync(lp, 'utf8'));
      if (info.ai && info.ai !== 'cursor') return false;
      if (ownerId) {
        if (!info.owner_id || info.owner_id !== ownerId) return false;
      }
      fs.unlinkSync(lp);
      return true;
    }) === true;
  } catch (_) {
    return false;
  }
}

function buildPrompt(userPrompt, { vaultRoot, readOnly } = {}) {
  const modeNote = readOnly
    ? 'Chế độ READ-ONLY (plan/ask): KHÔNG ghi file vault. Chỉ phân tích và đề xuất.'
    : 'Có thể ghi vault CHỈ khi anh ra lệnh rõ / token Human Gate (ghi, !reflect, nút ✅). Tôn trọng Single Driver: lock ai:cursor từ telebot. DEFAULT = không tự reflect/tự publish atom.';

  const gated = withVaultWriteGate(userPrompt);

  return [
    '[Telegram → Cursor gateway · vault nexmeOS]',
    'Anh Công gửi lệnh từ Telegram. Em là cửa Cursor (filesystem), xưng "em", gọi "anh".',
    `Workspace: ${vaultRoot || DEFAULT_WORKSPACE}`,
    modeNote,
    'Đầu việc: nếu cần ngữ cảnh vận hành, đọc `_handoff.md` (và `_Core/CONTEXT.md` nếu liên quan).',
    'Cuối phiên nếu đã sửa file có ý nghĩa: cập nhật metadata + ghi sổ `_handoff.md`.',
    'Ops data (tiền/task/hội viên) → Supabase Hot Brain CLI trước; Markdown chỉ narrative.',
    '',
    gated,
  ].join('\n');
}

function toolLabel(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return 'tool';
  const key = Object.keys(toolCall)[0];
  if (!key) return 'tool';
  const payload = toolCall[key] || {};
  const args = payload.args || {};
  let detail = '';
  if (args.path) detail = `: ${path.basename(args.path)}`;
  else if (args.command) detail = `: ${String(args.command).slice(0, 40)}`;
  else if (args.file_path) detail = `: ${path.basename(args.file_path)}`;
  const pretty = key.replace(/ToolCall$/, '').replace(/([A-Z])/g, ' $1').trim();
  return `${pretty || key}${detail}`;
}

/**
 * Send prompt to Cursor Agent CLI (headless print mode).
 * @param {string} prompt
 * @param {object} opts
 * @returns {Promise<{text: string, sessionId: string, toolsUsed: string[], duration: number, lockHeld: boolean}>}
 */
function sendToCursor(prompt, opts = {}) {
  const {
    chatId,
    workDir,
    model,
    resumeSessionId,
    mode, // 'ask' | 'plan' | undefined (agent)
    force = CURSOR_FORCE,
    skipLock = false,
    onEvent,
  } = opts;

  const workspace = workDir || DEFAULT_WORKSPACE;
  const readOnly = mode === 'ask' || mode === 'plan';
  let lockHeld = false;
  let lockOwnerId = null;
  let vaultRoot = resolveVaultRoot(workspace);

  if (!skipLock && !readOnly) {
    const lock = acquireVaultLock(workspace, `telebot chat=${chatId || '?'}`);
    if (!lock.ok) {
      const err = new Error(
        `Vault đang bị khoá bởi ${lock.lockedBy} (~${lock.ageMin} phút). ` +
        `Session: ${lock.session || 'n/a'}. Đợi xong hoặc dùng /cursor_ask (read-only).`
      );
      err.code = 'VAULT_LOCKED';
      err.lock = lock;
      return Promise.reject(err);
    }
    lockHeld = true;
    lockOwnerId = lock.ownerId || null;
    vaultRoot = lock.vaultRoot;
    if (chatId) {
      const s = sessions.get(chatId) || {};
      s.lockHeld = true;
      s.lockOwnerId = lockOwnerId;
      s.vaultRoot = vaultRoot;
      sessions.set(chatId, s);
    }
  }

  const fullPrompt = buildPrompt(prompt, { vaultRoot, readOnly });

  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--workspace', workspace,
      '--trust',
    ];

    if (force && !readOnly) args.push('--force');
    if (readOnly && mode) args.push('--mode', mode);
    if (CURSOR_SANDBOX === 'enabled' || CURSOR_SANDBOX === 'disabled') {
      args.push('--sandbox', CURSOR_SANDBOX);
    }

    const session = sessions.get(chatId);
    const sessionIdToResume = resumeSessionId || session?.sessionId;
    if (sessionIdToResume) {
      args.push('--resume', sessionIdToResume);
    }

    if (model) args.push('--model', model);

    args.push(fullPrompt);

    const spawnEnv = buildSpawnEnv();
    if (process.env.CURSOR_API_KEY) {
      args.splice(args.length - 1, 0, '--api-key', process.env.CURSOR_API_KEY);
    }

    const proc = spawn(CURSOR_BIN, args, {
      cwd: workspace,
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (chatId) {
      const existing = sessions.get(chatId) || {};
      existing.proc = proc;
      existing.lockHeld = lockHeld;
      existing.lockOwnerId = lockOwnerId;
      existing.vaultRoot = vaultRoot;
      sessions.set(chatId, existing);
    }

    let buffer = '';
    let finalText = '';
    let sessionId = sessionIdToResume || null;
    let toolsUsed = [];
    let duration = 0;
    let stderrBuf = '';

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          handleEvent(event);
          if (onEvent) onEvent(event);
        } catch {
          // non-JSON noise
        }
      }
    });

    function handleEvent(event) {
      switch (event.type) {
        case 'system':
          if (event.subtype === 'init' && event.session_id) {
            sessionId = event.session_id;
            if (chatId) {
              const s = sessions.get(chatId) || {};
              s.sessionId = sessionId;
              sessions.set(chatId, s);
            }
          }
          break;

        case 'assistant':
          if (event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) {
                finalText = block.text;
              }
            }
          }
          break;

        case 'tool_call':
          if (event.subtype === 'started' && event.tool_call) {
            toolsUsed.push(toolLabel(event.tool_call));
          }
          break;

        case 'result':
          duration = event.duration_ms || 0;
          if (event.session_id) sessionId = event.session_id;
          if (event.subtype === 'success' && event.result) {
            finalText = event.result;
          }
          if (event.is_error && event.result) {
            finalText = finalText || event.result;
          }
          break;
      }
    }

    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Timeout ${CURSOR_TIMEOUT / 1000}s`));
    }, CURSOR_TIMEOUT);

    const cleanupLock = () => {
      if (lockHeld) {
        releaseVaultLock(vaultRoot, lockOwnerId);
        lockHeld = false;
        if (chatId) {
          const s = sessions.get(chatId) || {};
          s.lockHeld = false;
          s.lockOwnerId = null;
          sessions.set(chatId, s);
        }
      }
    };

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (chatId) {
        const s = sessions.get(chatId) || {};
        s.proc = null;
        sessions.set(chatId, s);
      }

      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          handleEvent(event);
          if (onEvent) onEvent(event);
        } catch {}
      }

      cleanupLock();

      if (finalText || code === 0) {
        resolve({
          text: finalText,
          sessionId,
          toolsUsed: [...new Set(toolsUsed)],
          duration,
          lockHeld: false,
        });
      } else {
        const hint = stderrBuf.trim().split('\n').slice(-3).join(' | ');
        const authHint = AUTH_FAIL_RE.test(stderrBuf)
          ? ` — Cursor Agent chưa login. ${AUTH_FIX_HINT}`
          : '';
        reject(new Error(`Cursor exited ${code}${authHint}${hint ? ` | ${hint}` : ''}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (chatId) {
        const s = sessions.get(chatId) || {};
        s.proc = null;
        sessions.set(chatId, s);
      }
      cleanupLock();
      reject(new Error(`Spawn failed (${CURSOR_BIN}): ${err.message}`));
    });
  });
}

function cancelSession(chatId) {
  const session = sessions.get(chatId);
  if (session?.proc) {
    session.proc.kill('SIGTERM');
    session.proc = null;
    if (session.lockHeld) {
      releaseVaultLock(session.vaultRoot || DEFAULT_WORKSPACE, session.lockOwnerId || null);
      session.lockHeld = false;
      session.lockOwnerId = null;
    }
    return true;
  }
  return false;
}

function resetSession(chatId) {
  cancelSession(chatId);
  sessions.delete(chatId);
}

function isSessionActive(chatId) {
  return !!sessions.get(chatId)?.proc;
}

function getSessionInfo(chatId) {
  const s = sessions.get(chatId);
  return { sessionId: s?.sessionId || null, isActive: !!s?.proc };
}

function setActiveSession(chatId, sessionId) {
  const s = sessions.get(chatId) || {};
  s.sessionId = sessionId;
  sessions.set(chatId, s);
}

function getLastSessionId(chatId) {
  return sessions.get(chatId)?.sessionId || null;
}

/**
 * Capture Cursor IDE window or Mac screen (not CDP DOM like Antigravity).
 * Requires Screen Recording permission on macOS.
 */
function captureCursorScreenshot() {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'darwin') {
      return reject(new Error('Chụp màn hình Cursor chỉ hỗ trợ macOS.'));
    }

    const tmpPath = path.join(os.tmpdir(), `cursor-shot-${Date.now()}.png`);
    const cleanup = () => {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    };

    const runCapture = (args, source) => {
      exec(`screencapture ${args} "${tmpPath}"`, { timeout: 15000 }, (err) => {
        if (err || !fs.existsSync(tmpPath)) {
          cleanup();
          return reject(new Error('screencapture thất bại — kiểm tra quyền Screen Recording.'));
        }
        try {
          const buffer = fs.readFileSync(tmpPath);
          cleanup();
          resolve({ buffer, source });
        } catch (e) {
          cleanup();
          reject(e);
        }
      });
    };

    const windowScript = `
      tell application "System Events"
        set cursorProc to missing value
        repeat with p in (every process whose name is "Cursor")
          set cursorProc to p
          exit repeat
        end repeat
        if cursorProc is missing value then return "0"
        set frontmost of cursorProc to true
        delay 0.15
        try
          return (id of front window of cursorProc) as string
        on error
          return "0"
        end try
      end tell
    `.replace(/\s+/g, ' ').trim();

    exec(`osascript -e ${JSON.stringify(windowScript)}`, { timeout: 8000 }, (err, stdout) => {
      const wid = parseInt(String(stdout || '').trim(), 10);
      if (!err && wid > 0) {
        return runCapture(`-x -l${wid}`, 'Cửa sổ Cursor');
      }
      runCapture('-x', 'Toàn màn hình Mac (Cursor không mở hoặc không lấy được window ID)');
    });
  });
}

// ===== Cursor IDE enabled models (applicationUser) + agent CLI fallback =====
const modelsCache = { at: 0, models: [], source: '' };
const MODELS_CACHE_MS = 30 * 1000;

const CURSOR_STATE_VSCDB = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Cursor',
  'User',
  'globalStorage',
  'state.vscdb'
);
const CURSOR_APP_USER_KEY =
  'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';

// Model IDs may include provider prefixes: gcli/grok-4.5, 9f/pro/..., cx/...
const MODEL_ID_RE = /^[a-z0-9][\w.+\-\/]*(?:\[[^\]]+\])?$/i;

function clearCursorModelsCache() {
  modelsCache.at = 0;
  modelsCache.models = [];
  modelsCache.source = '';
}

/**
 * Parse CLI model list into { id, label }[].
 * Tolerant of several agent output formats. Keeps provider prefixes (gcli/...).
 */
function parseCursorModelsOutput(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  const models = [];
  const seen = new Set();

  function push(id, label) {
    const clean = String(id || '').trim();
    if (!clean) return;
    if (/^(usage|options|available|models?|list|command|error):/i.test(clean)) return;
    if (clean.length > 120) return;
    if (!MODEL_ID_RE.test(clean) && clean !== 'auto') return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    models.push({ id: clean, label: label ? `${clean} — ${label}` : clean });
  }

  for (let raw of lines) {
    let line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!line) continue;
    line = line.replace(/^[-*•]\s+/, '').replace(/^\d+[\).\]]\s+/, '');

    let m = line.match(/^([a-z0-9][\w.+\-\/]*(?:\[[^\]]+\])?)\s*[-—–:]\s+(.+)$/i);
    if (m) {
      push(m[1], m[2].trim());
      continue;
    }

    m = line.match(/^(.+?)\s+\(([a-z0-9][\w.+\-\/]*(?:\[[^\]]+\])?)\)$/i);
    if (m) {
      push(m[2], m[1].trim());
      continue;
    }

    m = line.match(/^([a-z0-9][\w.+\-\/]*(?:\[[^\]]+\])?)$/i);
    if (m) {
      push(m[1], null);
    }
  }

  if (models.length && !seen.has('auto')) {
    models.unshift({ id: 'auto', label: 'auto — default router' });
  } else {
    const idx = models.findIndex((x) => x.id === 'auto');
    if (idx > 0) {
      const [a] = models.splice(idx, 1);
      models.unshift(a);
    }
  }
  return models;
}

/**
 * Models currently ON in this Cursor IDE (same toggle list as model picker).
 * Source: state.vscdb → applicationUser.aiSettings
 *  - modelOverrideEnabled / modelOverrideDisabled
 *  - availableDefaultModels2[].defaultOn
 *  - userAddedModels
 * Returns full IDs with prefixes (e.g. gcli/grok-4.5).
 */
function readCursorIdeEnabledModels() {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') {
      return resolve({ models: [], source: '', error: 'Cursor IDE state only on macOS' });
    }
    if (!fs.existsSync(CURSOR_STATE_VSCDB)) {
      return resolve({ models: [], source: '', error: 'state.vscdb not found' });
    }

    const sql =
      `SELECT value FROM ItemTable WHERE key = '${CURSOR_APP_USER_KEY.replace(/'/g, "''")}';`;

    execFile(
      'sqlite3',
      ['-readonly', CURSOR_STATE_VSCDB, sql],
      { timeout: 12000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err || !stdout || !String(stdout).trim()) {
          return resolve({
            models: [],
            source: '',
            error: (err && err.message) || String(stderr || 'empty state.vscdb').slice(0, 160),
          });
        }
        try {
          const raw = String(stdout).trim();
          const data = JSON.parse(raw);
          const ai = data.aiSettings || {};
          const catalog = Array.isArray(data.availableDefaultModels2)
            ? data.availableDefaultModels2
            : [];
          const enabledOverride = new Set(
            (ai.modelOverrideEnabled || []).map((x) => String(x).trim()).filter(Boolean)
          );
          const disabledOverride = new Set(
            (ai.modelOverrideDisabled || []).map((x) => String(x).trim()).filter(Boolean)
          );

          // "Đang bật" = explicit ON toggles + catalog defaultOn, trừ explicit OFF.
          // Không nhét userAdded (nhiều model đã add rồi tắt trong IDE).
          const on = new Set();
          for (const id of ai.modelOverrideEnabled || []) {
            const clean = String(id || '').trim();
            if (!clean || disabledOverride.has(clean)) continue;
            if (MODEL_ID_RE.test(clean) || clean === 'auto' || clean === 'default') on.add(clean);
          }

          for (const m of catalog) {
            const name = String((m && (m.name || m.serverModelName)) || '').trim();
            if (!name || disabledOverride.has(name)) continue;
            const defaultOn = !!(m && m.defaultOn);
            if (defaultOn || enabledOverride.has(name)) {
              if (MODEL_ID_RE.test(name) || name === 'auto' || name === 'default') on.add(name);
            }
          }

          const models = [];
          const seen = new Set();
          function pushId(id) {
            const clean = String(id || '').trim();
            if (!clean) return;
            const key = clean.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            models.push({ id: clean, label: clean });
          }

          pushId('auto');
          try {
            const cur =
              (ai.modelConfig &&
                ai.modelConfig.composer &&
                (ai.modelConfig.composer.modelName ||
                  (ai.modelConfig.composer.selectedModels &&
                    ai.modelConfig.composer.selectedModels[0] &&
                    ai.modelConfig.composer.selectedModels[0].modelId))) ||
              '';
            if (cur && on.has(cur)) pushId(cur);
          } catch (_) {}

          // Keep IDE toggle order first (exact prefixes: gcli/..., 9f/pro/...)
          for (const id of ai.modelOverrideEnabled || []) {
            const clean = String(id || '').trim();
            if (on.has(clean)) pushId(clean);
          }
          for (const id of [...on].sort((a, b) => a.localeCompare(b))) {
            pushId(id);
          }

          if (models.length <= 1) {
            return resolve({
              models: [],
              source: '',
              error: 'no enabled models in Cursor IDE state',
            });
          }

          resolve({
            models,
            source: 'cursor-ide-enabled',
            error: null,
          });
        } catch (e) {
          resolve({
            models: [],
            source: '',
            error: `parse applicationUser: ${(e && e.message) || e}`.slice(0, 160),
          });
        }
      }
    );
  });
}

function listCursorModelsFromAgentCli() {
  return new Promise((resolve) => {
    const env = buildSpawnEnv();
    const attempts = [['models'], ['--list-models']];

    function run(i) {
      if (i >= attempts.length) {
        return resolve({
          models: [{ id: 'auto', label: 'auto' }],
          source: 'fallback',
          error: 'agent models failed (auth or CLI)',
        });
      }
      const args = attempts[i];
      execFile(CURSOR_BIN, args, { env, timeout: 25000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const out = `${stdout || ''}\n${stderr || ''}`;
        if (err && !stdout) {
          console.error('[cursor models]', args.join(' '), err.message, String(stderr || '').slice(0, 160));
          return run(i + 1);
        }
        const models = parseCursorModelsOutput(out);
        if (!models.length) {
          console.error(
            '[cursor models] empty parse from',
            args.join(' '),
            'sample:',
            out.slice(0, 200).replace(/\n/g, ' | ')
          );
          return run(i + 1);
        }
        resolve({ models, source: `agent ${args.join(' ')}`, error: null });
      });
    }
    run(0);
  });
}

/**
 * Prefer models currently ON in Cursor IDE (exact IDs + prefixes).
 * Fallback: agent CLI model list if IDE state unavailable.
 * @param {{ force?: boolean }} opts
 * @returns {Promise<{ models: Array<{id:string,label:string}>, source: string, error?: string }>}
 */
async function listCursorModels(opts = {}) {
  const force = !!opts.force;
  if (!force && modelsCache.models.length && Date.now() - modelsCache.at < MODELS_CACHE_MS) {
    return { models: modelsCache.models, source: modelsCache.source || 'cache' };
  }

  const ide = await readCursorIdeEnabledModels();
  if (ide.models && ide.models.length > 1) {
    modelsCache.at = Date.now();
    modelsCache.models = ide.models;
    modelsCache.source = ide.source;
    return { models: ide.models, source: ide.source };
  }

  const cli = await listCursorModelsFromAgentCli();
  modelsCache.at = Date.now();
  modelsCache.models = cli.models;
  modelsCache.source = cli.source;
  if (ide.error && cli.source === 'fallback') {
    return { ...cli, error: `${ide.error}; ${cli.error || ''}`.trim() };
  }
  if (ide.error && cli.models && cli.models.length) {
    return {
      models: cli.models,
      source: cli.source,
      error: `IDE: ${ide.error} → dùng agent CLI`,
    };
  }
  return cli;
}

module.exports = {
  sendToCursor,
  cancelSession,
  resetSession,
  isSessionActive,
  getSessionInfo,
  setActiveSession,
  getLastSessionId,
  checkVaultLock,
  acquireVaultLock,
  releaseVaultLock,
  resolveVaultRoot,
  captureCursorScreenshot,
  checkCursorAuth,
  formatAuthStatusHtml,
  buildSpawnEnv,
  listCursorModels,
  clearCursorModelsCache,
  DEFAULT_WORKSPACE,
  CURSOR_BIN,
};
