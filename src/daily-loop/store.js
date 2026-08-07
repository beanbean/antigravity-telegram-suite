const fs = require('fs');
const path = require('path');
const os = require('os');

const PROCESSING_TTL_MS = Number(process.env.DAILY_LOOP_PROCESSING_TTL_MS) || 5 * 60 * 1000;

function isStaleProcessing(entry, now = Date.now()) {
  if (!entry || entry.status !== 'processing') return false;
  const updatedAt = Date.parse(entry.updatedAt || '');
  if (Number.isNaN(updatedAt)) return true;
  return now - updatedAt > PROCESSING_TTL_MS;
}

class JsonStore {
  constructor(file = process.env.DAILY_LOOP_STATE_FILE || path.join(os.homedir(), '.telebot', 'daily-loop.json')) {
    this.file = file;
    this.backup = `${file}.bak`;
  }

  read() {
    for (const candidate of [this.file, this.backup]) {
      try {
        if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, 'utf8'));
      } catch (error) {
        console.error(`[DailyLoop] Invalid store ${candidate}:`, error.message);
      }
    }
    return { version: 1, chats: {}, processedCallbacks: {}, events: [] };
  }

  write(state) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.backup);
    fs.renameSync(tmp, this.file);
  }

  update(mutator) {
    const state = this.read();
    const result = mutator(state);
    this.write(state);
    return result;
  }

  chat(chatId) {
    const state = this.read();
    return state.chats[String(chatId)] || {};
  }

  updateChat(chatId, mutator) {
    return this.update((state) => {
      const key = String(chatId);
      state.chats[key] ||= {};
      return mutator(state.chats[key], state);
    });
  }

  beginAction(id) {
    return this.update((state) => {
      state.actions ||= {};
      const existing = state.actions[id];
      if (existing?.status === 'completed') return false;
      if (existing?.status === 'processing' && !isStaleProcessing(existing)) return false;
      state.actions[id] = { status: 'processing', updatedAt: new Date().toISOString() };
      state.actions = Object.fromEntries(Object.entries(state.actions).slice(-1000));
      return true;
    });
  }

  finishAction(id, status, error = null) {
    if (!['completed', 'failed'].includes(status)) throw new Error('Invalid action status');
    return this.update((state) => {
      state.actions ||= {};
      state.actions[id] = { status, error, updatedAt: new Date().toISOString() };
    });
  }

  claimCallback(id) {
    return this.beginAction(id);
  }

  event(chatId, type, data = {}) {
    this.update((state) => {
      state.events ||= [];
      state.events.push({ at: new Date().toISOString(), chatId: String(chatId), type, ...data });
      state.events = state.events.slice(-5000);
    });
  }
}

module.exports = { JsonStore, isStaleProcessing, PROCESSING_TTL_MS };
