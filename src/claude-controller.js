/**
 * claude-controller.js
 * Stream-based bridge to Claude Code CLI.
 * Uses --output-format stream-json for real-time event streaming.
 * Supports --resume for persistent sessions + nexmeOS vault Single Driver lock.
 */

const { spawn } = require('child_process');
const path = require('path');
const { withVaultWriteGate } = require('./vault-write-policy');
const fs = require('fs');
const os = require('os');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT, 10) || 900000;
const CLAUDE_SETTINGS_FILE = process.env.CLAUDE_SETTINGS_FILE || '';

/** Prefer vault path; never treat bare $HOME as workspace when Projects/nexmeOS exists. */
function resolveDefaultWorkspace() {
  const projects = path.join(os.homedir(), 'Projects', 'nexmeOS');
  const fromEnv = (process.env.CLAUDE_WORK_DIR || '').trim();
  if (fromEnv) {
    try {
      const resolved = path.resolve(fromEnv);
      if (resolved === path.resolve(os.homedir()) && fs.existsSync(projects)) {
        return projects;
      }
    } catch (_) {}
    return fromEnv;
  }
  return projects;
}

const DEFAULT_WORKSPACE = resolveDefaultWorkspace();

const LOCK_TTL_MS = 30 * 60 * 1000;
const LOCK_AI = 'claude-code';

// Load ANTHROPIC_AUTH_TOKEN1 from ~/.env.secrets if not already in env
function loadClaudibleToken() {
  if (process.env.CLAUDIBLE_AUTH_TOKEN) return process.env.CLAUDIBLE_AUTH_TOKEN;
  try {
    const secrets = fs.readFileSync(path.join(os.homedir(), '.env.secrets'), 'utf-8');
    const match = secrets.match(/^export\s+ANTHROPIC_AUTH_TOKEN1=["']?([^"'\n]+)["']?/m);
    if (match) return match[1].trim();
  } catch {}
  return '';
}
const CLAUDIBLE_AUTH_TOKEN = loadClaudibleToken();

// Session tracking: chatId -> { sessionId, proc, lockHeld, lockOwnerId, vaultRoot }
const sessions = new Map();

function resolveVaultRoot(workDir) {
  const candidates = [
    workDir,
    path.join(os.homedir(), 'Projects', 'nexmeOS'),
    path.join(
      os.homedir(),
      'Library',
      'Mobile Documents',
      'iCloud~md~obsidian',
      'Documents',
      'BrainCong',
      'nexmeOS'
    ),
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
  while (Date.now() < end) {
    /* spin short wait for gate */
  }
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
        try {
          fs.rmdirSync(gate);
        } catch (_) {}
      }
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(gate);
        if (Date.now() - st.mtimeMs > 60000) {
          try {
            fs.rmdirSync(gate);
          } catch (_) {}
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
      return {
        ok: true,
        vaultRoot,
        stale: true,
        lockedBy: info.ai || 'unknown',
        ageMin: Math.round(age / 60000),
        raw,
      };
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
    // A lock that exists but cannot be read is not safe to treat as free.
    return {
      ok: false,
      vaultRoot,
      lockedBy: 'unknown',
      ageMin: 0,
      session: 'unreadable-lock',
      error: e && e.code ? e.code : 'read-lock-failed',
    };
  }
}

function sanitizeSessionLabel(label) {
  return (
    String(label || 'telebot-claude')
      .replace(/[\r\n"]+/g, ' ')
      .trim()
      .slice(0, 80) || 'telebot-claude'
  );
}

/**
 * Acquire via gate + O_EXCL. Unlink-stale and create happen under same gate (no TOCTOU).
 */
function acquireVaultLock(workDir, sessionLabel = 'telebot-claude') {
  const vaultRoot = resolveVaultRoot(workDir);
  const lp = lockPath(vaultRoot);
  const ownerId = `claude-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const label = sanitizeSessionLabel(sessionLabel);

  const body = [
    `ai: ${LOCK_AI}`,
    `session: "${label}"`,
    `started: "${formatNow()}"`,
    `owner_id: "${ownerId}"`,
    '',
  ].join('\n');

  try {
    return withLockGate(vaultRoot, () => {
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
          try {
            fs.unlinkSync(lp);
          } catch (_) {}
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
          lockedBy: LOCK_AI,
          ageMin: 0,
          session: e && e.code === 'EEXIST' ? 'lock-race' : `lock-error:${e && e.code}`,
        };
      }
    });
  } catch (e) {
    return {
      ok: false,
      vaultRoot,
      lockedBy: 'gate',
      ageMin: 0,
      session: e.message || 'lock-gate-timeout',
    };
  }
}

function releaseVaultLock(workDir, ownerId = null) {
  const vaultRoot = resolveVaultRoot(workDir);
  const lp = lockPath(vaultRoot);
  try {
    return (
      withLockGate(vaultRoot, () => {
        if (!fs.existsSync(lp)) return true;
        const info = parseLock(fs.readFileSync(lp, 'utf8'));
        if (info.ai && info.ai !== LOCK_AI) return false;
        if (ownerId) {
          if (!info.owner_id || info.owner_id !== ownerId) return false;
        }
        fs.unlinkSync(lp);
        return true;
      }) === true
    );
  } catch (_) {
    return false;
  }
}

function buildPrompt(userPrompt, { vaultRoot, readOnly } = {}) {
  const modeNote = readOnly
    ? 'Chế độ READ-ONLY (ask): KHÔNG ghi file vault. Chỉ phân tích và đề xuất.'
    : 'Có thể ghi vault CHỈ khi anh ra lệnh rõ / token Human Gate (ghi, !reflect, nút ✅). Tôn trọng Single Driver: lock ai:claude-code từ telebot. DEFAULT = không tự reflect/tự publish atom.';

  const gated = withVaultWriteGate(userPrompt);

  return [
    '[Telegram → Claude Code gateway · vault nexmeOS]',
    'Anh Công gửi lệnh từ Telegram. Em là Khôi (Claude Code), xưng "em", gọi "anh".',
    `Workspace: ${vaultRoot || DEFAULT_WORKSPACE}`,
    modeNote,
    'Đầu việc: nếu cần ngữ cảnh vận hành, đọc `_handoff.md` (và `_Core/CONTEXT.md` nếu liên quan).',
    'Cuối phiên nếu đã sửa file có ý nghĩa: cập nhật metadata + ghi sổ `_handoff.md`.',
    'Ops data (tiền/task/hội viên) → Supabase Hot Brain CLI trước; Markdown chỉ narrative.',
    '',
    gated,
  ].join('\n');
}

/**
 * Send prompt to Claude Code with streaming events.
 * @param {string} prompt
 * @param {object} opts - { chatId, workDir, model, skipPermissions, resumeSessionId, mode, skipLock, onEvent }
 * @returns {Promise<{text: string, sessionId: string, toolsUsed: string[], duration: number, lockHeld: boolean}>}
 */
function sendToClaude(prompt, opts = {}) {
  const {
    chatId,
    workDir,
    model,
    skipPermissions,
    resumeSessionId,
    mode, // 'ask' | undefined (agent)
    skipLock = false,
    onEvent,
  } = opts;

  const workspace = workDir || DEFAULT_WORKSPACE;
  const readOnly = mode === 'ask';
  let lockHeld = false;
  let lockOwnerId = null;
  let vaultRoot = resolveVaultRoot(workspace);

  if (!skipLock && !readOnly) {
    const lock = acquireVaultLock(workspace, `telebot chat=${chatId || '?'}`);
    if (!lock.ok) {
      const err = new Error(
        `Vault đang bị khoá bởi ${lock.lockedBy} (~${lock.ageMin} phút). ` +
          `Session: ${lock.session || 'n/a'}. Đợi xong hoặc dùng /claude_ask (read-only).`
      );
      err.code = 'VAULT_LOCKED';
      err.lock = lock;
      return Promise.reject(err);
    }
    lockHeld = true;
    lockOwnerId = lock.ownerId || null;
    vaultRoot = lock.vaultRoot;
  }

  let fullPrompt;
  try {
    fullPrompt = buildPrompt(prompt, { vaultRoot, readOnly });
  } catch (err) {
    if (lockHeld) releaseVaultLock(vaultRoot, lockOwnerId);
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    const request = {
      proc: null,
      lockHeld,
      lockOwnerId,
      vaultRoot,
      settled: false,
      cancelled: false,
      timer: null,
      cancel: null,
    };

    const isCurrentRequest = () => chatId && sessions.get(chatId)?.request === request;

    const clearActiveState = () => {
      if (!isCurrentRequest()) return;
      const state = sessions.get(chatId) || {};
      state.proc = null;
      state.request = null;
      state.lockHeld = false;
      state.lockOwnerId = null;
      sessions.set(chatId, state);
    };

    const cleanupLock = () => {
      if (request.lockHeld) {
        releaseVaultLock(request.vaultRoot, request.lockOwnerId);
        request.lockHeld = false;
      }
      if (isCurrentRequest()) {
        const state = sessions.get(chatId) || {};
        state.lockHeld = false;
        state.lockOwnerId = null;
        sessions.set(chatId, state);
      }
    };

    const resolveOnce = (value) => {
      if (request.settled) return;
      request.settled = true;
      if (request.timer) clearTimeout(request.timer);
      cleanupLock();
      clearActiveState();
      resolve(value);
    };

    const rejectOnce = (err) => {
      if (request.settled) return;
      request.settled = true;
      if (request.timer) clearTimeout(request.timer);
      cleanupLock();
      clearActiveState();
      reject(err);
    };

    const state = sessions.get(chatId);
    const sessionIdToResume = resumeSessionId || state?.sessionId;
    const args = ['-p', fullPrompt, '--output-format', 'stream-json', '--verbose'];

    // Plan permission mode is the CLI-level read-only enforcement for ask.
    if (readOnly) args.push('--permission-mode', 'plan');
    if (sessionIdToResume) args.push('--resume', sessionIdToResume);
    if (model) args.push('--model', model);
    if (CLAUDE_SETTINGS_FILE) args.push('--settings', CLAUDE_SETTINGS_FILE);
    if (skipPermissions && !readOnly) args.push('--dangerously-skip-permissions');

    const spawnEnv = { ...process.env, NO_COLOR: '1' };
    if (CLAUDIBLE_AUTH_TOKEN) spawnEnv.ANTHROPIC_AUTH_TOKEN = CLAUDIBLE_AUTH_TOKEN;

    let proc;
    try {
      proc = spawn(CLAUDE_BIN, args, {
        cwd: workspace,
        env: spawnEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      rejectOnce(new Error(`Spawn failed (${CLAUDE_BIN}): ${err.message}`));
      return;
    }

    request.proc = proc;
    if (chatId) {
      const current = sessions.get(chatId) || {};
      current.proc = proc;
      current.request = request;
      current.lockHeld = lockHeld;
      current.lockOwnerId = lockOwnerId;
      current.vaultRoot = vaultRoot;
      sessions.set(chatId, current);
    }

    let buffer = '';
    let finalText = '';
    let sessionId = sessionIdToResume || null;
    const toolsUsed = [];
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
          // Skip non-JSON lines and callback errors.
        }
      }
    });

    function handleEvent(event) {
      switch (event.type) {
        case 'system':
          if (event.subtype === 'init' && event.session_id) {
            sessionId = event.session_id;
            if (isCurrentRequest()) {
              const current = sessions.get(chatId) || {};
              current.sessionId = sessionId;
              sessions.set(chatId, current);
            }
          }
          break;
        case 'assistant':
          if (event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) finalText = block.text;
              if (block.type === 'tool_use') toolsUsed.push(block.name || 'unknown');
            }
          }
          break;
        case 'result':
          duration = event.duration_ms || 0;
          if (event.session_id) sessionId = event.session_id;
          if (event.subtype === 'success' && event.result) finalText = event.result;
          if (event.is_error && event.result) finalText = finalText || event.result;
          break;
      }
    }

    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
    });

    request.timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) {}
      rejectOnce(new Error(`Timeout ${CLAUDE_TIMEOUT / 1000}s`));
    }, CLAUDE_TIMEOUT);

    request.cancel = () => {
      request.cancelled = true;
      try { proc.kill('SIGTERM'); } catch (_) {}
      rejectOnce(new Error('Claude request cancelled'));
    };

    proc.on('close', (code) => {
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          handleEvent(event);
          if (onEvent) onEvent(event);
        } catch {}
      }
      if (request.cancelled || request.settled) return;
      if (finalText || code === 0) {
        resolveOnce({
          text: finalText,
          sessionId,
          toolsUsed: [...new Set(toolsUsed)],
          duration,
          lockHeld: false,
        });
      } else {
        const hint = stderrBuf.trim().split('\n').slice(-3).join(' | ');
        rejectOnce(new Error(`Claude exited ${code}${hint ? ` | ${hint}` : ''}`));
      }
    });

    proc.on('error', (err) => {
      rejectOnce(new Error(`Spawn failed (${CLAUDE_BIN}): ${err.message}`));
    });
  });
}

function cancelSession(chatId) {
  const session = sessions.get(chatId);
  if (!session?.proc) return false;
  if (session.request?.cancel) {
    session.request.cancel();
    return true;
  }
  try { session.proc.kill('SIGTERM'); } catch (_) {}
  if (session.lockHeld) {
    releaseVaultLock(session.vaultRoot || DEFAULT_WORKSPACE, session.lockOwnerId || null);
  }
  session.proc = null;
  session.lockHeld = false;
  session.lockOwnerId = null;
  sessions.set(chatId, session);
  return true;
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
  return {
    sessionId: s?.sessionId || null,
    isActive: !!s?.proc,
    lockHeld: !!s?.lockHeld,
  };
}

function setActiveSession(chatId, sessionId) {
  const s = sessions.get(chatId) || {};
  s.sessionId = sessionId;
  sessions.set(chatId, s);
}

function getLastSessionId(chatId) {
  return sessions.get(chatId)?.sessionId || null;
}

// ===== Claude Code models from ~/.claude/settings.json =====
const CLAUDE_SETTINGS_PATH =
  process.env.CLAUDE_SETTINGS_JSON || path.join(os.homedir(), '.claude', 'settings.json');
const claudeModelsCache = { at: 0, models: [], source: '' };
const CLAUDE_MODELS_CACHE_MS = 30 * 1000;
const CLAUDE_MODEL_ID_RE = /^[a-z0-9][\w.+\-\/]*(?:\[[^\]]+\])?$/i;

function clearClaudeModelsCache() {
  claudeModelsCache.at = 0;
  claudeModelsCache.models = [];
  claudeModelsCache.source = '';
}

/**
 * Models configured for this Claude Code install.
 * Prefer settings.json → models[] (exact IDs with prefixes: kr/..., gcli/..., 9f/pro/...).
 * Also surface ANTHROPIC_DEFAULT_* targets so mapped full IDs appear.
 * @param {{ force?: boolean }} opts
 * @returns {Promise<{ models: Array<{id:string,label:string}>, source: string, error?: string }>}
 */
function listClaudeModels(opts = {}) {
  const force = !!opts.force;
  if (!force && claudeModelsCache.models.length && Date.now() - claudeModelsCache.at < CLAUDE_MODELS_CACHE_MS) {
    return Promise.resolve({
      models: claudeModelsCache.models,
      source: claudeModelsCache.source || 'cache',
    });
  }

  return new Promise((resolve) => {
    const settingsPath = CLAUDE_SETTINGS_FILE || CLAUDE_SETTINGS_PATH;
    let data;
    try {
      if (!fs.existsSync(settingsPath)) {
        return resolve({
          models: [],
          source: 'fallback',
          error: `settings not found: ${settingsPath}`,
        });
      }
      data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      return resolve({
        models: [],
        source: 'fallback',
        error: `parse settings: ${(e && e.message) || e}`.slice(0, 160),
      });
    }

    const models = [];
    const seen = new Set();
    function push(id, label) {
      const clean = String(id || '').trim();
      if (!clean) return;
      if (clean.length > 120) return;
      if (!CLAUDE_MODEL_ID_RE.test(clean) && !['haiku', 'sonnet', 'opus', 'auto'].includes(clean)) return;
      const key = clean.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      models.push({ id: clean, label: label ? `${clean} — ${label}` : clean });
    }

    const list = Array.isArray(data.models) ? data.models : [];
    for (const m of list) {
      if (typeof m === 'string') {
        push(m, null);
        continue;
      }
      if (!m || typeof m !== 'object') continue;
      const id = m.id || m.model || m.name || m.value;
      const name = m.name || m.displayName || m.label || null;
      push(id, name && name !== id ? name : null);
    }

    const env = data.env || {};
    for (const target of [
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      env.CLAUDE_CODE_SUBAGENT_MODEL,
    ]) {
      if (target) push(String(target).trim(), 'env default');
    }

    if (data.model) push(String(data.model).trim(), 'default');

    if (!models.length) {
      push('haiku', 'built-in alias');
      push('sonnet', 'built-in alias');
      push('opus', 'built-in alias');
      claudeModelsCache.at = Date.now();
      claudeModelsCache.models = models;
      claudeModelsCache.source = 'fallback-aliases';
      return resolve({
        models,
        source: 'fallback-aliases',
        error: 'models[] empty in settings — used built-in aliases',
      });
    }

    claudeModelsCache.at = Date.now();
    claudeModelsCache.models = models;
    claudeModelsCache.source = 'claude-settings-models';
    resolve({ models, source: 'claude-settings-models' });
  });
}

module.exports = {
  sendToClaude,
  cancelSession,
  resetSession,
  isSessionActive,
  getSessionInfo,
  setActiveSession,
  getLastSessionId,
  listClaudeModels,
  clearClaudeModelsCache,
  checkVaultLock,
  acquireVaultLock,
  releaseVaultLock,
  resolveVaultRoot,
  resolveDefaultWorkspace,
  buildPrompt,
  DEFAULT_WORKSPACE,
  CLAUDE_BIN,
  LOCK_AI,
  LOCK_TTL_MS,
};
