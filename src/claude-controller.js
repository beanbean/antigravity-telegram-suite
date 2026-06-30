/**
 * claude-controller.js
 * Stream-based bridge to Claude Code CLI.
 * Uses --output-format stream-json for real-time event streaming.
 * Supports --resume for persistent sessions.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT) || 900000;
const CLAUDE_SETTINGS_FILE = process.env.CLAUDE_SETTINGS_FILE || '';

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

// Session tracking: chatId -> { sessionId, proc }
const sessions = new Map();

/**
 * Send prompt to Claude Code with streaming events.
 * @param {string} prompt
 * @param {object} opts - { chatId, workDir, model, skipPermissions, onEvent }
 * @returns {Promise<{text: string, sessionId: string, toolsUsed: string[], duration: number}>}
 */
function sendToClaude(prompt, opts = {}) {
  const { chatId, workDir, model, skipPermissions, resumeSessionId, onEvent } = opts;

  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];

    // Resume existing session (prefer explicit resumeSessionId)
    const session = sessions.get(chatId);
    const sessionIdToResume = resumeSessionId || session?.sessionId;
    if (sessionIdToResume) {
      args.push('--resume', sessionIdToResume);
    }

    if (model) {
      args.push('--model', model);
    }

    if (CLAUDE_SETTINGS_FILE) {
      args.push('--settings', CLAUDE_SETTINGS_FILE);
    }

    if (skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    const cwd = workDir || process.env.CLAUDE_WORK_DIR || process.env.HOME;

    // Pass claudible auth token if configured (used with --settings claudible-settings.json)
    const spawnEnv = { ...process.env, NO_COLOR: '1' };
    if (CLAUDIBLE_AUTH_TOKEN) {
      spawnEnv.ANTHROPIC_AUTH_TOKEN = CLAUDIBLE_AUTH_TOKEN;
    }

    const proc = spawn(CLAUDE_BIN, args, {
      cwd,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Track active process
    if (chatId) {
      const existing = sessions.get(chatId) || {};
      existing.proc = proc;
      sessions.set(chatId, existing);
    }

    let buffer = '';
    let finalText = '';
    let sessionId = sessionIdToResume || null;
    let toolsUsed = [];
    let duration = 0;

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          handleEvent(event);
          if (onEvent) onEvent(event);
        } catch {
          // Skip non-JSON lines
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
              if (block.type === 'tool_use') {
                toolsUsed.push(block.name || 'unknown');
              }
            }
          }
          break;

        case 'result':
          duration = event.duration_ms || 0;
          if (event.subtype === 'success' && event.result) {
            finalText = event.result;
          }
          break;
      }
    }

    proc.stderr.on('data', () => {}); // Suppress stderr

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Timeout ${CLAUDE_TIMEOUT / 1000}s`));
    }, CLAUDE_TIMEOUT);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (chatId) {
        const s = sessions.get(chatId) || {};
        s.proc = null;
        sessions.set(chatId, s);
      }

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          handleEvent(event);
          if (onEvent) onEvent(event);
        } catch {}
      }

      if (finalText || code === 0) {
        resolve({ text: finalText, sessionId, toolsUsed: [...new Set(toolsUsed)], duration });
      } else {
        reject(new Error(`Claude exited ${code}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (chatId) {
        const s = sessions.get(chatId) || {};
        s.proc = null;
        sessions.set(chatId, s);
      }
      reject(new Error(`Spawn failed: ${err.message}`));
    });
  });
}

function cancelSession(chatId) {
  const session = sessions.get(chatId);
  if (session?.proc) {
    session.proc.kill('SIGTERM');
    session.proc = null;
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

module.exports = {
  sendToClaude,
  cancelSession,
  resetSession,
  isSessionActive,
  getSessionInfo,
  setActiveSession,
  getLastSessionId
};
