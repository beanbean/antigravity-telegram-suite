const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JsonStore } = require('./store');
const { HotBrainAdapter } = require('./hotbrain');
const { extractFromReflection } = require('./extract');
const { buildFocusProposal } = require('./focus-sources');
const { dateKey, parseRelativeDate, stripTaskDate, startOfWeek } = require('./utils');

const HABITS = ['Thiền', 'Ôm hôn vợ', 'Hỏi The ONE Thing', 'Tập thể dục', 'Đọc sách'];
const LIFE_ITEMS = [
  { key: 'capture', label: 'Capture' },
  { key: 'reflect', label: 'Reflect' },
  { key: 'ops', label: 'Ops' },
  { key: 'content', label: 'Content' },
  { key: 'close', label: 'Close' },
];
const emptyLifeDay = () => Object.fromEntries(LIFE_ITEMS.map((item) => [item.key, false]));
const enabled = (name) => process.env[name] === 'true';
const id = () => crypto.randomBytes(8).toString('hex');
const keyboard = (rows) => ({ reply_markup: { inline_keyboard: rows } });
const PLACEHOLDER_FOCUS = 'Chọn The ONE Thing hôm nay';

function updateFrontmatter(content, now) {
  if (!content.startsWith('---\n')) return content;
  const end = content.indexOf('\n---\n', 4);
  if (end < 0) return content;
  let yaml = content.slice(4, end);
  const set = (key, value) => {
    const line = `${key}: "${value}"`;
    const pattern = new RegExp(`^${key}:.*$`, 'm');
    yaml = pattern.test(yaml) ? yaml.replace(pattern, line) : `${yaml}\n${line}`;
  };
  set('last_modified_by', 'Cursor');
  set('last_modified_date', now.replace('T', ' ').slice(0, 19));
  return `---\n${yaml}\n---\n${content.slice(end + 5)}`;
}

function createDailyLoop(options = {}) {
  const store = options.store || new JsonStore();
  const db = options.db || new HotBrainAdapter();
  const lock = options.lock || require('../cursor-controller');
  const vaultRoot = lock.resolveVaultRoot
    ? lock.resolveVaultRoot(options.vaultRoot || process.env.NEXMEOS_VAULT)
    : options.vaultRoot;

  function featureOn() { return enabled('DAILY_LOOP_ENABLED'); }
  function moduleOn(name) { return featureOn() && enabled(name); }
  function active(chatId) { return Boolean(store.chat(chatId).active); }
  function blocksEngineRouting(chatId) {
    return store.chat(chatId).active?.type === 'confirm';
  }

  async function logEvent(chatId, type, data = {}) {
    store.event(chatId, type, data);
    await db.safeQuery(
      'SELECT daily_loop_log_event(?, ?, ?::jsonb);',
      [String(chatId), type, JSON.stringify(data)]
    );
  }

  function formatHabitSummary(rows) {
    const map = new Map((rows || []).map((row) => [row.habit_name, row.checked]));
    return HABITS.map((habit) => `${map.get(habit) ? '✅' : '⬜'} ${habit}`).join('\n');
  }

  async function sendHabitSummary(ctx) {
    const summary = await db.safeQuery('SELECT * FROM daily_loop_habit_summary(?);', [dateKey()]);
    if (!summary.ok) return '';
    const text = formatHabitSummary(summary.rows);
    return text ? `\n\n📋 Hôm nay:\n${text}` : '';
  }

  async function proposeExtracted(ctx, candidate) {
    const payload = { ...candidate, fromExtract: true };
    if (candidate.type === 'task') return proposeTask(ctx, payload);
    if (candidate.type === 'interaction') return proposeInteraction(ctx, payload);
    const candidateId = id();
    store.updateChat(ctx.chat.id, (chat) => {
      chat.active = { type: 'confirm', candidateId };
      chat.candidates ||= {};
      chat.candidates[candidateId] = { ...candidate, fromExtract: true, createdAt: new Date().toISOString() };
    });
    const label = candidate.type === 'decision' ? 'Quyết định' : 'Candidate';
    await ctx.reply(`🔍 Từ reflection, em thấy ${label}:\n“${candidate.title}”\n\nAnh xác nhận trước khi ghi nhé.`, keyboard([
      [{ text: '✅ Xác nhận', callback_data: `dl:confirm:${candidateId}` }, { text: '❌ Hủy', callback_data: `dl:cancel:${candidateId}` }],
    ]));
  }

  async function processExtractQueue(ctx) {
    const chat = store.chat(ctx.chat.id);
    const queue = chat.extractQueue || [];
    if (!queue.length) return;
    const next = queue[0];
    store.updateChat(ctx.chat.id, (state) => { state.extractQueue = queue.slice(1); });
    await proposeExtracted(ctx, next);
  }

  async function startWeeklyProjectReview(ctx) {
    const result = await db.safeQuery('SELECT * FROM daily_loop_projects_need_review();', []);
    if (!result.ok || !result.rows.length) return false;
    const queue = result.rows.map((row) => ({
      projectId: row.project_id,
      projectName: row.project_name,
      projectStatus: row.project_status,
    }));
    store.updateChat(ctx.chat.id, (chat) => {
      chat.weeklyProjectQueue = queue;
      chat.active = { type: 'weekly-project', projectId: queue[0].projectId };
    });
    await ctx.reply(`📁 Project “${queue[0].projectName}” chưa có next action.\nAnh nhập việc tiếp theo, hoặc gõ: \`bỏ qua\`, \`chờ\`, \`xong\`.`);
    return true;
  }

  async function handleWeeklyProjectReply(ctx, text) {
    const chat = store.chat(ctx.chat.id);
    const queue = chat.weeklyProjectQueue || [];
    const current = queue.find((item) => item.projectId === chat.active?.projectId) || queue[0];
    if (!current) {
      store.updateChat(ctx.chat.id, (state) => { state.active = null; state.weeklyProjectQueue = []; });
      return true;
    }
    const lower = text.trim().toLocaleLowerCase('vi');
    if (/^(?:bỏ qua|bo qua|skip)$/.test(lower)) {
      return advanceWeeklyProject(ctx, queue, current.projectId);
    }
    if (/^(?:chờ|cho|waiting)$/.test(lower)) {
      await db.safeQuery('SELECT daily_loop_set_project_status(?, ?);', [current.projectId, 'future']);
      await ctx.reply(`📁 “${current.projectName}” → Đang chờ (future).`);
      return advanceWeeklyProject(ctx, queue, current.projectId);
    }
    if (/^(?:xong|hoàn tất|hoan tat|completed|done)$/.test(lower)) {
      await db.safeQuery('SELECT daily_loop_set_project_status(?, ?);', [current.projectId, 'completed']);
      await ctx.reply(`📁 “${current.projectName}” → Hoàn tất.`);
      return advanceWeeklyProject(ctx, queue, current.projectId);
    }
    const candidateId = id();
    const candidate = {
      type: 'task',
      title: text.trim(),
      dueDate: null,
      evidence: `Weekly next action — ${current.projectName}: ${text.trim()}`,
      projectId: current.projectId,
      projectName: current.projectName,
    };
    store.updateChat(ctx.chat.id, (state) => {
      state.candidates ||= {};
      state.candidates[candidateId] = candidate;
      state.active = { type: 'confirm', candidateId, resumeWeeklyProject: current.projectId };
    });
    await ctx.reply(`📝 Next action cho “${current.projectName}”:\n${candidate.title}\n\nAnh xác nhận trước khi ghi nhé.`, keyboard([
      [{ text: '✅ Xác nhận', callback_data: `dl:confirm:${candidateId}` }, { text: '❌ Hủy', callback_data: `dl:cancel:${candidateId}` }],
    ]));
    return true;
  }

  async function advanceWeeklyProject(ctx, queue, finishedProjectId) {
    const remaining = queue.filter((item) => item.projectId !== finishedProjectId);
    if (!remaining.length) {
      store.updateChat(ctx.chat.id, (state) => { state.active = null; state.weeklyProjectQueue = []; });
      await logEvent(ctx.chat.id, 'weekly_reset_completed');
      await ctx.reply('📅 Weekly Reset xong — mọi project active đã có next action hoặc đã đổi trạng thái.');
      return true;
    }
    store.updateChat(ctx.chat.id, (state) => {
      state.weeklyProjectQueue = remaining;
      state.active = { type: 'weekly-project', projectId: remaining[0].projectId };
    });
    await ctx.reply(`📁 Tiếp theo: “${remaining[0].projectName}”.\nAnh nhập next action, hoặc \`bỏ qua\` / \`chờ\` / \`xong\`.`);
    return true;
  }

  function parseExplicit(text) {
    const raw = String(text || '').trim();
    const lower = raw.toLocaleLowerCase('vi');
    const habit = HABITS.find((item) => lower === `đã ${item.toLocaleLowerCase('vi')}` || lower === `chưa ${item.toLocaleLowerCase('vi')}`);
    if (habit && moduleOn('DAILY_LOOP_HABITS_ENABLED')) return { type: 'habit', habit, checked: lower.startsWith('đã ') };
    const task = raw.match(/^(?:\/task|nhắc anh|ghi task|task:)\s+(.+)/i);
    if (task && moduleOn('DAILY_LOOP_CAPTURE_ENABLED')) {
      const dueDate = parseRelativeDate(task[1]);
      return { type: 'task', title: stripTaskDate(task[1]), dueDate, evidence: raw };
    }
    const interaction = raw.match(/^(?:\/cham|\/interaction|anh đã (?:gọi|nhắn|gặp))\s+(.+)/i);
    if (interaction && moduleOn('DAILY_LOOP_CAPTURE_ENABLED')) return { type: 'interaction', personName: interaction[1].trim(), evidence: raw };
    if (moduleOn('DAILY_LOOP_CLOSE_ENABLED') && /^(?:\/dongngay|đóng ngày|\/retryreflection)\b/i.test(raw)) return { type: 'close-start', retry: /^\/retryreflection/i.test(raw) };
    if (moduleOn('DAILY_LOOP_WEEKLY_ENABLED') && /^(?:\/tuan|weekly reset)\b/i.test(raw)) return { type: 'weekly-start' };
    if (moduleOn('DAILY_LOOP_FOCUS_ENABLED') && /^(?:\/focus|the one thing)\b/i.test(raw)) return { type: 'focus-start' };
    if (featureOn() && /^(?:\/life|\/checklist|life loop|checklist)\b/i.test(raw)) return { type: 'life-start' };
    return null;
  }

  async function proposeTask(ctx, parsed) {
    const candidateId = id();
    store.updateChat(ctx.chat.id, (chat) => {
      chat.active = { type: 'confirm', candidateId };
      chat.candidates ||= {};
      chat.candidates[candidateId] = { ...parsed, fromExtract: Boolean(parsed.fromExtract), createdAt: new Date().toISOString() };
    });
    await logEvent(ctx.chat.id, 'task_capture_started');
    const details = [
      `Task: ${parsed.title}`,
      parsed.dueDate ? `Thời gian: ${parsed.dueDate}` : 'Thời gian: chưa xác định',
      'Người: chưa xác định',
      'Project: chưa xác định',
      `Bối cảnh: “${parsed.evidence}”`,
    ].join('\n');
    await ctx.reply(`📝 Em hiểu:\n${details}\n\nAnh xác nhận trước khi ghi nhé.`, keyboard([
      [{ text: '✅ Xác nhận', callback_data: `dl:confirm:${candidateId}` }, { text: '✏️ Sửa', callback_data: `dl:edit:${candidateId}` }],
      [{ text: '❌ Hủy', callback_data: `dl:cancel:${candidateId}` }],
    ]));
  }

  async function proposeInteraction(ctx, parsed) {
    const resolved = await db.safeQuery('SELECT id, name FROM people WHERE lower(name) = lower(?) LIMIT 2;', [parsed.personName]);
    if (!resolved.ok) return ctx.reply('⚠️ Hot Brain chưa sẵn sàng. Em giữ nguyên input, chưa ghi interaction.');
    if (resolved.rows.length !== 1) return ctx.reply(`⚠️ Em chưa resolve chính xác “${parsed.personName}”. Anh dùng đúng tên canonical rồi gửi lại nhé.`);
    const candidateId = id();
    const candidate = { ...parsed, personId: resolved.rows[0].id, personName: resolved.rows[0].name };
    store.updateChat(ctx.chat.id, (chat) => {
      chat.active = { type: 'confirm', candidateId };
      chat.candidates ||= {};
      chat.candidates[candidateId] = candidate;
    });
    await ctx.reply(`🤝 Em hiểu: đã chăm ${candidate.personName} hôm nay.\nAnh xác nhận trước khi ghi nhé.`, keyboard([
      [{ text: '✅ Xác nhận', callback_data: `dl:confirm:${candidateId}` }, { text: '❌ Hủy', callback_data: `dl:cancel:${candidateId}` }],
    ]));
  }

  async function setHabit(ctx, parsed) {
    const result = await db.safeQuery(
      "SELECT daily_loop_set_habit(?, ?, ?, ?);",
      [String(ctx.chat.id), dateKey(), parsed.habit, parsed.checked ? 'true' : 'false']
    );
    if (!result.ok) return ctx.reply(`⚠️ Chưa ghi được habit “${parsed.habit}”. Migration có thể chưa được apply; input không bị chuyển sang engine khác.`);
    await logEvent(ctx.chat.id, 'habit_checked', { habit: parsed.habit, checked: parsed.checked });
    const summary = await sendHabitSummary(ctx);
    await ctx.reply(`${parsed.checked ? '✅' : '⬜'} ${parsed.habit} — ${parsed.checked ? 'đã check' : 'đã bỏ check'}.${summary}`);
  }

  async function proposeReflection(ctx, text) {
    const day = dateKey();
    const trimmed = text.trim();
    const closureId = String(ctx.message?.message_id || ctx.update?.update_id || crypto.createHash('sha256').update(`${ctx.chat.id}:${day}:${trimmed}`).digest('hex').slice(0, 16));
    const candidateId = id();
    const preview = trimmed.length > 900 ? `${trimmed.slice(0, 900)}…` : trimmed;
    store.updateChat(ctx.chat.id, (chat) => {
      chat.pendingReflection = {
        day,
        text: trimmed,
        closureId,
        messageId: ctx.message?.message_id || null,
        updateId: ctx.update?.update_id || null,
        status: 'awaiting_confirm',
      };
      chat.candidates ||= {};
      chat.candidates[candidateId] = {
        type: 'reflection',
        text: trimmed,
        day,
        closureId,
        createdAt: new Date().toISOString(),
      };
      chat.active = { type: 'confirm', candidateId };
    });
    await logEvent(ctx.chat.id, 'close_day_preview', { closureId });
    await ctx.reply(
      `🌙 Em giữ bản đóng ngày (chưa ghi vault):\n\n${preview}\n\nThà không lưu còn hơn lưu rác. Anh xác nhận trước khi ghi Reflections/Daily nhé.`,
      keyboard([
        [{ text: '✅ Lưu vault', callback_data: `dl:confirm:${candidateId}` }, { text: '❌ Không lưu', callback_data: `dl:cancel:${candidateId}` }],
      ])
    );
  }

  async function saveReflection(ctx, text) {
    const day = dateKey();
    const closureId = String(ctx.message?.message_id || ctx.update?.update_id || crypto.createHash('sha256').update(`${ctx.chat.id}:${day}:${text.trim()}`).digest('hex').slice(0, 16));
    store.updateChat(ctx.chat.id, (chat) => {
      chat.pendingReflection = { day, text: text.trim(), closureId, messageId: ctx.message?.message_id || null, updateId: ctx.update?.update_id || null, status: 'pending' };
    });
    const dir = path.join(vaultRoot, '01-Atomic', 'Reflections', 'Daily');
    const file = path.join(dir, `${day}.md`);
    const acquired = lock.acquireVaultLock(vaultRoot, `daily-loop reflection ${day}`);
    if (!acquired.ok) {
      store.updateChat(ctx.chat.id, (chat) => { chat.active = null; });
      return ctx.reply(`🔒 Vault đang được ${acquired.lockedBy} sử dụng. Reflection đã giữ trong state.`, keyboard([
        [{ text: '🔄 Thử lưu lại', callback_data: `dl:reflection-retry:${closureId}` }],
        [{ text: '❌ Hủy đóng ngày', callback_data: `dl:cancel-close:${closureId}` }],
      ]));
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      const now = new Date().toISOString();
      const marker = `<!-- daily-loop:${ctx.chat.id}:${closureId} -->`;
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (existing.includes(marker)) {
        store.updateChat(ctx.chat.id, (chat) => { chat.active = null; chat.pendingReflection = null; });
        await ctx.reply('🌙 Reflection này đã được lưu trước đó.');
        return;
      }
      const initial = `---\ntype: "daily-reflection"\ndate: "${day}"\nlast_modified_by: "Cursor"\nlast_modified_date: "${now.replace('T', ' ').slice(0, 19)}"\n---\n\n# Đóng ngày ${day}\n`;
      const base = updateFrontmatter(existing || initial, now).trimEnd();
      const body = `${base}\n\n${marker}\n## Lần đóng ngày ${now.slice(11, 16)}\n\n${text.trim()}\n`;
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body, 'utf8');
      fs.renameSync(tmp, file);
      store.updateChat(ctx.chat.id, (chat) => { chat.active = null; chat.pendingReflection = null; chat.lastReflection = { day, text, closureId, savedAt: now }; });
      await logEvent(ctx.chat.id, 'close_day_completed');
      const extracted = extractFromReflection(text.trim());
      if (extracted.length) {
        store.updateChat(ctx.chat.id, (chat) => { chat.extractQueue = extracted; });
        await ctx.reply('🌙 Đã lưu reflection gốc (sau khi anh ✅). Em thấy thêm candidate — anh xác nhận từng mục nhé.');
        await processExtractQueue(ctx);
      } else {
        await ctx.reply('🌙 Đã lưu reflection gốc (sau khi anh ✅). Không thấy task/decision/interaction rõ để đề xuất thêm.');
      }
    } catch (error) {
      console.error('[DailyLoop] Reflection write failed:', error.message);
      store.updateChat(ctx.chat.id, (chat) => { chat.active = null; });
      await ctx.reply('⚠️ Ghi reflection thất bại. Input gốc vẫn còn trong state.', keyboard([
        [{ text: '🔄 Thử lưu lại', callback_data: `dl:reflection-retry:${closureId}` }],
        [{ text: '❌ Hủy đóng ngày', callback_data: `dl:cancel-close:${closureId}` }],
      ]));
    } finally {
      if (acquired.ok) lock.releaseVaultLock(vaultRoot, acquired.ownerId);
    }
  }

  async function dispatchParsed(ctx, parsed) {
    if (parsed.type === 'task') await proposeTask(ctx, parsed);
    else if (parsed.type === 'interaction') await proposeInteraction(ctx, parsed);
    else if (parsed.type === 'habit') await setHabit(ctx, parsed);
    else if (parsed.type === 'close-start') {
      if (parsed.retry) {
        const pending = store.chat(ctx.chat.id).pendingReflection;
        if (!pending) await ctx.reply('Không có reflection đang chờ lưu.');
        else await saveReflection(ctx, pending.text);
        return;
      }
      store.updateChat(ctx.chat.id, (state) => { state.active = { type: 'close-awaiting' }; });
      await ctx.reply('🌙 Trả lời một tin text/voice:\n1. Hôm nay điều gì đáng nhớ?\n2. Có gì thay đổi hoặc quyết định?\n3. Ngày mai một việc quan trọng là gì?');
    } else if (parsed.type === 'weekly-start') {
      store.updateChat(ctx.chat.id, (state) => { state.active = { type: 'weekly-awaiting' }; });
      await ctx.reply('📅 Weekly Reset:\n1. Một mục tiêu tuần tới\n2. Việc còn tồn\n3. Project nào đang chờ/bị chặn/hoàn tất\n4. Một bài học hoặc điều chỉnh');
    } else if (parsed.type === 'life-start') {
      await sendLifeChecklist(ctx);
    } else await sendFocusPrompt({ telegram: ctx.telegram, chatId: ctx.chat.id });
  }

  const AMBIENT_PREEMPT_TYPES = new Set(['task', 'habit', 'interaction', 'focus-start', 'weekly-start', 'life-start']);

  async function handleText(ctx, text) {
    if (!featureOn()) return false;
    const chat = store.chat(ctx.chat.id);
    if (blocksEngineRouting(ctx.chat.id)) {
      await ctx.reply('⏸ Em đang chờ anh bấm ✅ Xác nhận hoặc ❌ Hủy trên tin nhắn trước. Anh bấm nút trước khi gửi tin mới nhé.');
      return true;
    }
    if (chat.active?.type === 'focus-reason') {
      if (!moduleOn('DAILY_LOOP_FOCUS_ENABLED')) return false;
      store.updateChat(ctx.chat.id, (state) => {
        state.active = { type: 'focus-custom', replacementReason: text.trim() };
      });
      await ctx.reply('Anh nhập The ONE Thing thay thế:');
      return true;
    }
    if (chat.active?.type === 'focus-custom') {
      if (!moduleOn('DAILY_LOOP_FOCUS_ENABLED')) return false;
      const replacementReason = chat.active.replacementReason || '';
      const candidateId = id();
      store.updateChat(ctx.chat.id, (state) => {
        state.candidates ||= {};
        state.candidates[candidateId] = { type: 'focus', date: dateKey(), title: text.trim(), reason: replacementReason, source: 'user_entered' };
        state.active = { type: 'confirm', candidateId };
      });
      await ctx.reply(`🎯 Focus: ${text.trim()}${replacementReason ? `\nLý do thay thế: ${replacementReason}` : ''}\n\nAnh xác nhận trước khi ghi nhé.`, keyboard([
        [{ text: '✅ Xác nhận', callback_data: `dl:confirm:${candidateId}` }, { text: '❌ Hủy', callback_data: `dl:cancel:${candidateId}` }],
      ]));
      return true;
    }
    const parsed = parseExplicit(text);
    if (parsed) {
      const ambient = chat.active?.type;
      if (AMBIENT_PREEMPT_TYPES.has(parsed.type) && (ambient === 'close-awaiting' || ambient === 'weekly-awaiting')) {
        store.updateChat(ctx.chat.id, (state) => { state.active = null; });
      }
      await dispatchParsed(ctx, parsed);
      return true;
    }
    if (chat.active?.type === 'weekly-project') {
      if (!moduleOn('DAILY_LOOP_WEEKLY_ENABLED')) return false;
      await handleWeeklyProjectReply(ctx, text);
      return true;
    }
    if (chat.active?.type === 'close-awaiting') {
      if (!moduleOn('DAILY_LOOP_CLOSE_ENABLED')) return false;
      const lower = text.trim().toLocaleLowerCase('vi');
      if (/^(?:\/huy|hủy|huỷ|hủy đóng ngày|cancel)$/i.test(lower)) {
        store.updateChat(ctx.chat.id, (chat) => { chat.active = null; chat.pendingReflection = null; });
        await ctx.reply('❌ Đã hủy đóng ngày. Anh chat bình thường nhé.');
        return true;
      }
      await proposeReflection(ctx, text);
      return true;
    }
    if (chat.active?.type === 'weekly-awaiting') {
      if (!moduleOn('DAILY_LOOP_WEEKLY_ENABLED')) return false;
      const lower = text.trim().toLocaleLowerCase('vi');
      if (/^(?:\/huy|hủy|huỷ|cancel)$/i.test(lower)) {
        store.updateChat(ctx.chat.id, (chat) => { chat.active = null; });
        await ctx.reply('❌ Đã hủy weekly reset. Anh chat bình thường nhé.');
        return true;
      }
      const parts = text.split('\n').map((part) => part.replace(/^\s*\d+[.)-]?\s*/, '').trim()).filter(Boolean);
      const candidateId = id();
      const candidate = { type: 'weekly', raw: text.trim(), weekStart: startOfWeek(dateKey()), goal: parts[0] || text.trim(), lesson: parts[1] || '', adjustment: parts[2] || '' };
      store.updateChat(ctx.chat.id, (state) => { state.candidates ||= {}; state.candidates[candidateId] = candidate; state.weekly = { ...candidate, status: 'pending' }; state.active = { type: 'confirm', candidateId }; });
      await ctx.reply(`📅 Em hiểu:\nMục tiêu: ${candidate.goal}\nBài học: ${candidate.lesson || 'chưa xác định'}\nĐiều chỉnh: ${candidate.adjustment || 'chưa xác định'}\n\nBản gốc đã giữ trong state. Anh xác nhận trước khi ghi.`, keyboard([
        [{ text: '✅ Xác nhận', callback_data: `dl:confirm:${candidateId}` }, { text: '❌ Hủy', callback_data: `dl:cancel:${candidateId}` }],
      ]));
      return true;
    }
    return false;
  }

  async function handleCallback(ctx) {
    if (!featureOn()) return false;
    const data = ctx.callbackQuery?.data || '';
    if (!data.startsWith('dl:')) return false;
    const [, action, candidateId] = data.split(':');
    await ctx.answerCbQuery().catch(() => {});
    if (action === 'life') {
      return handleLifeCallback(ctx, candidateId);
    }
    if (action.startsWith('focus-') && !moduleOn('DAILY_LOOP_FOCUS_ENABLED')) return false;
    if (action === 'focus-custom') {
      store.updateChat(ctx.chat.id, (chat) => { chat.active = { type: 'focus-custom' }; });
      await ctx.reply('Anh nhập The ONE Thing hôm nay:');
      return true;
    }
    if (action === 'focus-replace') {
      store.updateChat(ctx.chat.id, (chat) => { chat.active = { type: 'focus-reason' }; });
      await ctx.reply('Vì sao việc này quan trọng hơn?');
      return true;
    }
    const focus = action === 'focus-confirm' ? store.chat(ctx.chat.id).focus : null;
    const stableId = candidateId || (focus ? crypto.createHash('sha256').update(`${focus.date}:${focus.title}`).digest('hex').slice(0, 16) : action);
    const actionKey = `${ctx.chat.id}:${stableId}:${action}`;
    if (!store.beginAction(actionKey)) { await ctx.answerCbQuery('Đang/đã xử lý'); return true; }
    const fail = () => store.finishAction(actionKey, 'failed');
    const complete = () => store.finishAction(actionKey, 'completed');
    if (action === 'cancel-close') {
      store.updateChat(ctx.chat.id, (chat) => { chat.active = null; chat.pendingReflection = null; });
      complete();
      await ctx.reply('❌ Đã hủy đóng ngày. Anh chat bình thường nhé.');
      return true;
    }
    if (action === 'reflection-retry') {
      if (!moduleOn('DAILY_LOOP_CLOSE_ENABLED')) { fail(); return false; }
      const pending = store.chat(ctx.chat.id).pendingReflection;
      if (!pending || pending.closureId !== candidateId) { complete(); await ctx.reply('Không có reflection này đang chờ lưu.'); return true; }
      await saveReflection(ctx, pending.text);
      if (store.chat(ctx.chat.id).pendingReflection) fail(); else complete();
      return true;
    }
    if (action === 'focus-confirm') {
      if (!focus || !focus.trustworthy || focus.title === PLACEHOLDER_FOCUS) {
        await ctx.reply('⚠️ Không có đề xuất đủ bằng chứng để xác nhận. Anh chọn “Tự nhập”.');
        complete();
        return true;
      }
      const result = await db.safeQuery(
        "SELECT daily_loop_upsert_focus(?, ?, ?, ?, ?, ?);",
        [focus.date, focus.title, focus.reason || '', 'ai_proposed', 'confirmed', focus.linkedTaskId || null]
      );
      store.updateChat(ctx.chat.id, (chat) => { chat.focus.status = result.ok ? 'confirmed' : 'pending_sync'; if (result.ok) chat.active = null; });
      await logEvent(ctx.chat.id, 'focus_confirmed', { persisted: result.ok });
      if (result.ok) { complete(); await ctx.reply(`🎯 Đã chọn: ${focus.title}\nBước nhỏ nhất: bắt đầu 10 phút đầu tiên.`); }
      else { fail(); await ctx.reply('⚠️ Chưa ghi được focus. Vẫn đang chờ đồng bộ.', keyboard([[{ text: '🔄 Thử lại', callback_data: 'dl:focus-confirm' }]])); }
      return true;
    }
    const chat = store.chat(ctx.chat.id);
    const candidate = chat.candidates?.[candidateId];
    if (!candidate) { complete(); await ctx.reply('⚠️ Candidate không còn tồn tại.'); return true; }
    if (action === 'cancel') {
      const resumeProject = chat.active?.resumeWeeklyProject;
      const wasExtract = chat.candidates?.[candidateId]?.fromExtract;
      const wasReflection = chat.candidates?.[candidateId]?.type === 'reflection';
      store.updateChat(ctx.chat.id, (state) => {
        delete state.candidates[candidateId];
        if (wasReflection) state.pendingReflection = null;
        state.active = resumeProject ? { type: 'weekly-project', projectId: resumeProject } : null;
      });
      await ctx.reply(wasReflection
        ? '❌ Không lưu reflection vault. Bản đóng ngày chỉ còn trong chat (nếu còn).'
        : 'Đã hủy, chưa ghi dữ liệu.');
      complete();
      if (wasExtract) await processExtractQueue(ctx);
      return true;
    }
    if (action === 'edit') {
      store.updateChat(ctx.chat.id, (state) => { delete state.candidates[candidateId]; state.active = null; });
      await ctx.reply('Anh gửi lại bằng cú pháp “nhắc anh …” để sửa nhé.');
      complete();
      return true;
    }
    if (action === 'confirm') {
      const resumeProject = chat.active?.resumeWeeklyProject;
      if (candidate.type === 'reflection') {
        store.updateChat(ctx.chat.id, (state) => { delete state.candidates[candidateId]; });
        await saveReflection(ctx, candidate.text);
        const stillPending = Boolean(store.chat(ctx.chat.id).pendingReflection);
        if (stillPending) fail();
        else {
          complete();
          await logEvent(ctx.chat.id, 'close_day_confirmed');
        }
        return true;
      }
      const result = candidate.type === 'task'
        ? await db.safeQuery(
          "SELECT daily_loop_create_task(?, ?, ?, ?, ?);",
          [candidateId, candidate.title, candidate.dueDate, candidate.evidence, candidate.projectId || null]
        )
        : candidate.type === 'interaction'
          ? await db.safeQuery("SELECT daily_loop_create_interaction(?, ?, ?, ?);", [candidateId, candidate.personId, dateKey(), candidate.evidence])
          : candidate.type === 'decision'
            ? await db.safeQuery(
              "SELECT daily_loop_create_decision(?, ?, ?, ?);",
              [candidateId, candidate.title, candidate.evidence, dateKey()]
            )
            : candidate.type === 'focus'
              ? await db.safeQuery(
                "SELECT daily_loop_upsert_focus(?, ?, ?, ?, ?, ?);",
                [candidate.date, candidate.title, candidate.reason || '', candidate.source, 'confirmed', candidate.linkedTaskId || null]
              )
              : await db.safeQuery("SELECT daily_loop_upsert_weekly(?, ?, ?, ?, ?);", [candidateId, candidate.weekStart, candidate.goal, candidate.lesson, candidate.adjustment]);
      if (result.ok) {
        store.updateChat(ctx.chat.id, (state) => { delete state.candidates[candidateId]; });
        const eventType = candidate.type === 'task' ? 'task_confirmed'
          : candidate.type === 'interaction' ? 'interaction_confirmed'
            : candidate.type === 'decision' ? 'decision_confirmed'
              : candidate.type === 'focus' ? 'focus_confirmed'
                : 'weekly_reset_completed';
        await logEvent(ctx.chat.id, eventType);
        if (candidate.type === 'weekly') {
          store.updateChat(ctx.chat.id, (state) => { state.active = null; });
          complete();
          await ctx.reply('📅 Đã lưu Weekly Reset.');
          await startWeeklyProjectReview(ctx);
          return true;
        }
        if (resumeProject && candidate.type === 'task') {
          const queue = store.chat(ctx.chat.id).weeklyProjectQueue || [];
          complete();
          await ctx.reply(`✅ Đã ghi next action cho “${candidate.projectName || 'project'}”: ${candidate.title}`);
          await advanceWeeklyProject(ctx, queue, resumeProject);
          return true;
        }
        store.updateChat(ctx.chat.id, (state) => { state.active = null; });
        complete();
        const replyText = candidate.type === 'task' ? `✅ Đã ghi task: ${candidate.title}`
          : candidate.type === 'interaction' ? `✅ Đã ghi interaction với ${candidate.personName}.`
            : candidate.type === 'decision' ? `✅ Đã ghi decision: ${candidate.title}`
              : candidate.type === 'focus' ? `🎯 Đã chọn: ${candidate.title}`
                : '📅 Đã lưu Weekly Reset.';
        await ctx.reply(replyText);
        if (candidate.fromExtract) await processExtractQueue(ctx);
        return true;
      } else {
        store.updateChat(ctx.chat.id, (state) => { state.candidates[candidateId].status = 'pending_sync'; });
        fail();
        await ctx.reply('⚠️ Chưa ghi được Hot Brain. Candidate vẫn đang chờ.', keyboard([[{ text: '🔄 Thử lại', callback_data: `dl:confirm:${candidateId}` }]]));
      }
      return true;
    }
    return true;
  }


  function lifeState(chatId, day = dateKey()) {
    const saved = store.chat(chatId).lifeLoop?.[day] || {};
    return { ...emptyLifeDay(), ...saved };
  }

  function formatLifeDay(day, state) {
    const done = LIFE_ITEMS.filter((item) => state[item.key]).length;
    const lines = LIFE_ITEMS.map((item) => `${state[item.key] ? '✅' : '⬜'} ${item.label}`);
    return `📋 Life Loop — ${day} (${done}/5)\n\n${lines.join('\n')}\n\nBấm nút để tick/bỏ tick. /life mở lại.`;
  }

  function lifeKeyboard(state) {
    const mark = (item) => ({
      text: `${state[item.key] ? '✅' : '⬜'} ${item.label}`,
      callback_data: `dl:life:${item.key}`,
    });
    return keyboard([
      LIFE_ITEMS.slice(0, 3).map(mark),
      LIFE_ITEMS.slice(3).map(mark),
      [{ text: '📅 Tuần (7 ngày)', callback_data: 'dl:life:week' }],
    ]);
  }

  function formatLifeWeek(chatId, endDay = dateKey()) {
    const [y, m, d] = endDay.split('-').map(Number);
    const lines = [];
    for (let offset = 6; offset >= 0; offset -= 1) {
      const day = dateKey(new Date(Date.UTC(y, m - 1, d - offset, 12)));
      const state = lifeState(chatId, day);
      const marks = LIFE_ITEMS.map((item) => (state[item.key] ? '✅' : '⬜')).join('');
      const done = LIFE_ITEMS.filter((item) => state[item.key]).length;
      lines.push(`${day}  ${marks}  ${done}/5`);
    }
    return `📅 Life Loop — 7 ngày gần nhất\n\n${lines.join('\n')}\n\n/life để tick hôm nay.`;
  }

  async function renderLifeMessage(ctx, day, state) {
    const body = formatLifeDay(day, state);
    const extra = lifeKeyboard(state);
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (messageId && ctx.telegram?.editMessageText) {
      try {
        await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, body, extra);
        return;
      } catch (error) {
        if (/message is not modified/i.test(error.message || '')) return;
      }
    }
    if (typeof ctx.editMessageText === 'function' && messageId) {
      try {
        await ctx.editMessageText(body, extra);
        return;
      } catch (error) {
        if (/message is not modified/i.test(error.message || '')) return;
      }
    }
    await ctx.reply(body, extra);
  }

  async function sendLifeChecklist(ctx) {
    if (!featureOn()) return false;
    const day = dateKey();
    const state = lifeState(ctx.chat.id, day);
    await logEvent(ctx.chat.id, 'life_checklist_opened', { day });
    await renderLifeMessage(ctx, day, state);
    return true;
  }

  async function handleLifeCallback(ctx, itemKey) {
    if (!featureOn()) return false;
    const day = dateKey();
    if (itemKey === 'week') {
      await ctx.reply(formatLifeWeek(ctx.chat.id, day));
      return true;
    }
    if (!LIFE_ITEMS.some((item) => item.key === itemKey)) {
      await ctx.reply('⚠️ Mục life loop không hợp lệ.');
      return true;
    }
    const next = store.updateChat(ctx.chat.id, (chat) => {
      chat.lifeLoop ||= {};
      chat.lifeLoop[day] = { ...emptyLifeDay(), ...(chat.lifeLoop[day] || {}) };
      chat.lifeLoop[day][itemKey] = !chat.lifeLoop[day][itemKey];
      const keys = Object.keys(chat.lifeLoop).sort();
      if (keys.length > 60) {
        for (const old of keys.slice(0, keys.length - 60)) delete chat.lifeLoop[old];
      }
      return chat.lifeLoop[day];
    });
    await logEvent(ctx.chat.id, 'life_item_toggled', { day, item: itemKey, checked: next[itemKey] });
    await renderLifeMessage(ctx, day, next);
    return true;
  }

  async function sendFocusPrompt({ telegram, chatId }) {
    if (!featureOn() || !enabled('DAILY_LOOP_FOCUS_ENABLED')) return false;
    const day = dateKey();
    const proposal = await buildFocusProposal(db, day);
    store.updateChat(chatId, (chat) => {
      chat.focus = proposal ? {
        date: day,
        title: proposal.title,
        reason: proposal.reason,
        status: 'proposed',
        trustworthy: proposal.trustworthy,
        linkedTaskId: proposal.linkedTaskId,
        linkedProjectId: proposal.linkedProjectId || null,
      } : null;
    });
    await logEvent(chatId, 'focus_prompt_sent', { source: proposal?.source || 'none' });
    const rows = proposal
      ? [[{ text: '✅ Chọn', callback_data: 'dl:focus-confirm' }, { text: '🔄 Thay thế', callback_data: 'dl:focus-replace' }], [{ text: '✍️ Tự nhập', callback_data: 'dl:focus-custom' }]]
      : [[{ text: '✍️ Tự nhập', callback_data: 'dl:focus-custom' }]];
    await telegram.sendMessage(chatId, proposal
      ? `🌅 Daily Glass\n\n🎯 ${proposal.title}\nLý do: ${proposal.reason}`
      : `🌅 Daily Glass\n\nEm chưa đủ dữ liệu để đề xuất đáng tin. Anh chọn The ONE Thing hôm nay nhé.`, keyboard(rows));
    return true;
  }

  async function sendCloseDayPrompt({ telegram, chatId }) {
    if (!featureOn() || !enabled('DAILY_LOOP_CLOSE_ENABLED')) return false;
    store.updateChat(chatId, (chat) => { chat.active = { type: 'close-awaiting' }; });
    await telegram.sendMessage(chatId, '🌙 Đóng ngày bằng một tin text/voice:\n1. Hôm nay điều gì đáng nhớ?\n2. Có gì thay đổi hoặc quyết định?\n3. Ngày mai một việc quan trọng là gì?');
    return true;
  }

  async function sendWeeklyPrompt({ telegram, chatId }) {
    if (!featureOn() || !enabled('DAILY_LOOP_WEEKLY_ENABLED')) return false;
    store.updateChat(chatId, (chat) => { chat.active = { type: 'weekly-awaiting' }; });
    await telegram.sendMessage(chatId, '📅 Weekly Reset (10–15 phút): mục tiêu tuần, việc còn tồn, trạng thái project + next action, một bài học/điều chỉnh.');
    return true;
  }

  return {
    handleText,
    handleCallback,
    sendFocusPrompt,
    sendCloseDayPrompt,
    sendWeeklyPrompt,
    sendLifeChecklist,
    isActive: active,
    blocksEngineRouting,
    parseExplicit,
  };
}

module.exports = { createDailyLoop, HABITS, LIFE_ITEMS, parseRelativeDate, stripTaskDate, dateKey, startOfWeek };
