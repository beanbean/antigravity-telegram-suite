const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonStore, isStaleProcessing, PROCESSING_TTL_MS } = require('../src/daily-loop/store');
const { HotBrainAdapter } = require('../src/daily-loop/hotbrain');
const { createDailyLoop, parseRelativeDate, stripTaskDate } = require('../src/daily-loop');
const { extractFromReflection } = require('../src/daily-loop/extract');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-loop-test-'));
  const store = new JsonStore(path.join(dir, 'state.json'));
  store.updateChat('1', (chat) => { chat.active = { type: 'x' }; });
  assert.strictEqual(store.chat('1').active.type, 'x');
  assert.strictEqual(store.beginAction('cb1'), true);
  assert.strictEqual(store.beginAction('cb1'), false);
  store.finishAction('cb1', 'failed');
  assert.strictEqual(store.beginAction('cb1'), true, 'failed actions must be retryable');
  store.finishAction('cb1', 'completed');
  assert(fs.existsSync(path.join(dir, 'state.json')));

  assert.strictEqual(isStaleProcessing({ status: 'processing', updatedAt: new Date(Date.now() - PROCESSING_TTL_MS - 1000).toISOString() }), true);
  assert.strictEqual(isStaleProcessing({ status: 'processing', updatedAt: new Date().toISOString() }), false);
  const staleStore = new JsonStore(path.join(dir, 'stale-actions.json'));
  staleStore.update((state) => {
    state.actions = {
      stuck: { status: 'processing', updatedAt: new Date(Date.now() - PROCESSING_TTL_MS - 1000).toISOString() },
    };
  });
  assert.strictEqual(staleStore.beginAction('stuck'), true, 'stale processing actions must be reclaimable');
  assert.strictEqual(staleStore.read().actions.stuck.status, 'processing');

  let rendered;
  const db = new HotBrainAdapter({ run: async (sql) => { rendered = sql; return []; } });
  await db.query('select ? as value', ["a'b"]);
  assert(rendered.includes("'a''b'"), 'SQL input must be escaped');
  const unavailable = new HotBrainAdapter({ run: async () => { throw new Error('offline'); } });
  assert.strictEqual((await unavailable.safeQuery('select 1')).ok, false);

  process.env.DAILY_LOOP_ENABLED = 'true';
  process.env.DAILY_LOOP_CAPTURE_ENABLED = 'true';
  process.env.DAILY_LOOP_HABITS_ENABLED = 'true';
  process.env.DAILY_LOOP_FOCUS_ENABLED = 'true';
  process.env.DAILY_LOOP_CLOSE_ENABLED = 'true';
  process.env.DAILY_LOOP_WEEKLY_ENABLED = 'true';
  assert.strictEqual(parseRelativeDate('gọi Phát ngày mai', new Date('2026-07-19T12:00:00+07:00')), '2026-07-20');
  assert.strictEqual(parseRelativeDate('gọi Phát hôm nay', new Date('2026-07-19T12:00:00+07:00')), '2026-07-19');
  assert.strictEqual(parseRelativeDate('gọi Phát', new Date('2026-07-19T12:00:00+07:00')), null);
  assert.strictEqual(stripTaskDate('gọi Phát ngày mai'), 'gọi Phát');
  const extracted = extractFromReflection('Hôm nay ổn\nQuyết định dừng ads\nNgày mai gọi Phát', new Date('2026-07-19T12:00:00+07:00'));
  assert(extracted.some((item) => item.type === 'task'), 'reflection extract must find task');
  assert(extracted.some((item) => item.type === 'decision'), 'reflection extract must find decision');
  const narrativeOnly = extractFromReflection('hôm nay về nhà bà nội, vui', new Date('2026-07-19T12:00:00+07:00'));
  assert.strictEqual(narrativeOnly.length, 0, 'past narrative must not become task');
  const calls = [];
  const fakeDb = { safeQuery: async (sql, params) => { calls.push({ sql, params }); return { ok: true, rows: [] }; } };
  const taskCreateCalls = () => calls.filter((call) => call.sql.includes('daily_loop_create_task'));
  const loop = createDailyLoop({ store, db: fakeDb, vaultRoot: dir, lock: {
    acquireVaultLock: () => ({ ok: true, ownerId: 'x' }),
    releaseVaultLock: () => true,
  } });
  const confirmReplies = [];
  store.updateChat('7', (chat) => { chat.active = { type: 'confirm', candidateId: 'abc' }; });
  assert.strictEqual(loop.blocksEngineRouting('7'), true);
  assert.strictEqual(await loop.handleText({ chat: { id: 7 }, reply: async (...args) => confirmReplies.push(args) }, 'hello while pending'), true);
  assert(confirmReplies[0][0].includes('chờ anh bấm'), 'confirm state must block plain text');
  assert.strictEqual(loop.parseExplicit('hello'), null);
  assert.strictEqual(loop.parseExplicit('đã thiền').type, 'habit');
  const parsedTask = loop.parseExplicit('nhắc anh gọi Phát ngày mai');
  assert.strictEqual(parsedTask.type, 'task');
  assert.strictEqual(parsedTask.title, 'gọi Phát');
  assert(parsedTask.dueDate, 'tomorrow must produce a due date');

  const replies = [];
  const ctx = { chat: { id: 2 }, reply: async (...args) => { replies.push(args); }, callbackQuery: null };
  assert.strictEqual(await loop.handleText(ctx, 'hello'), false, 'ordinary text must not be intercepted');
  assert.strictEqual(await loop.handleText(ctx, 'nhắc anh gọi Phát ngày mai'), true);
  assert.strictEqual(taskCreateCalls().length, 0, 'task must not write before confirmation');
  const candidateId = store.chat(2).active.candidateId;
  ctx.callbackQuery = { id: 'callback-1', data: `dl:confirm:${candidateId}` };
  ctx.answerCbQuery = async () => {};
  assert.strictEqual(await loop.handleCallback(ctx), true);
  assert.strictEqual(taskCreateCalls().length, 1);
  assert.strictEqual(taskCreateCalls()[0].params[1], 'gọi Phát');
  assert.strictEqual(taskCreateCalls()[0].params[2], parsedTask.dueDate);
  assert.strictEqual(await loop.handleCallback(ctx), true, 'duplicate callback is consumed');
  assert.strictEqual(taskCreateCalls().length, 1, 'duplicate callback must not write twice');

  const retryStore = new JsonStore(path.join(dir, 'retry-state.json'));
  let attempts = 0;
  const retryLoop = createDailyLoop({ store: retryStore, db: { safeQuery: async (sql) => {
    if (sql.includes('daily_loop_create_task')) return { ok: ++attempts > 1, rows: [] };
    return { ok: true, rows: [] };
  } }, vaultRoot: dir, lock: {
    acquireVaultLock: () => ({ ok: true, ownerId: 'x' }), releaseVaultLock: () => true,
  } });
  const retryCtx = { chat: { id: 20 }, reply: async () => {}, answerCbQuery: async () => {}, callbackQuery: null };
  await retryLoop.handleText(retryCtx, 'nhắc anh gọi Phát hôm nay');
  const retryCandidate = retryStore.chat(20).active.candidateId;
  retryCtx.callbackQuery = { id: 'retry-1', data: `dl:confirm:${retryCandidate}` };
  await retryLoop.handleCallback(retryCtx);
  assert(retryStore.chat(20).candidates[retryCandidate], 'failed write must preserve candidate');
  retryCtx.callbackQuery = { id: 'retry-2', data: `dl:confirm:${retryCandidate}` };
  await retryLoop.handleCallback(retryCtx);
  assert.strictEqual(retryStore.chat(20).candidates[retryCandidate], undefined, 'retry must complete candidate');

  store.updateChat('3', (chat) => { chat.active = { type: 'close-awaiting' }; });
  const reflectionDir = path.join(dir, '01-Atomic', 'Reflections', 'Daily');
  fs.mkdirSync(reflectionDir, { recursive: true });
  const reflectionFile = path.join(reflectionDir, `${new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'Asia/Ho_Chi_Minh' })}.md`);
  fs.writeFileSync(reflectionFile, '---\ntype: "daily-reflection"\nlast_modified_by: "Khôi"\nlast_modified_date: "old"\n---\n\n# Nội dung cũ\n\nKhông được mất.\n');
  const reflectionReplies = [];
  const reflectionReplyCtx = {
    chat: { id: 3 },
    message: { message_id: 99 },
    reply: async (...args) => reflectionReplies.push(args),
    answerCbQuery: async () => {},
  };
  await loop.handleText(reflectionReplyCtx, 'Điều đáng nhớ\nQuyết định\nViệc ngày mai');
  assert.strictEqual(fs.readFileSync(reflectionFile, 'utf8').includes('Điều đáng nhớ'), false, 'P0: must not write vault before confirm');
  assert(reflectionReplies.some((args) => String(args[0]).includes('chưa ghi vault')), 'must show reflection preview');
  assert.strictEqual(store.chat(3).active?.type, 'confirm');
  const reflectionCandidateId = store.chat(3).active.candidateId;
  assert.strictEqual(store.chat(3).candidates[reflectionCandidateId].type, 'reflection');
  reflectionReplyCtx.callbackQuery = { id: 'ref-confirm-1', data: `dl:confirm:${reflectionCandidateId}` };
  await loop.handleCallback(reflectionReplyCtx);
  const savedReflection = fs.readFileSync(reflectionFile, 'utf8');
  assert(savedReflection.includes('Không được mất.'), 'existing reflection content must be preserved');
  assert(savedReflection.includes('daily-loop:3:99'), 'reflection closure must have an idempotency marker');
  assert(reflectionReplies.some((args) => String(args[0]).includes('Đã lưu reflection')), 'reflection must save after confirm');
  store.updateChat('3', (chat) => {
    chat.active = { type: 'close-awaiting' };
    chat.extractQueue = [];
    chat.pendingReflection = null;
  });
  await loop.handleText(reflectionReplyCtx, 'Điều đáng nhớ\nQuyết định\nViệc ngày mai');
  const secondCandidateId = store.chat(3).active.candidateId;
  reflectionReplyCtx.callbackQuery = { id: 'ref-confirm-2', data: `dl:confirm:${secondCandidateId}` };
  await loop.handleCallback(reflectionReplyCtx);
  assert.strictEqual((fs.readFileSync(reflectionFile, 'utf8').match(/daily-loop:3:99/g) || []).length, 1);

  const lockedStore = new JsonStore(path.join(dir, 'locked-state.json'));
  const lockedReplies = [];
  const lockedLoop = createDailyLoop({ store: lockedStore, db: fakeDb, vaultRoot: dir, lock: {
    acquireVaultLock: () => ({ ok: false, lockedBy: 'An' }), releaseVaultLock: () => true,
  } });
  lockedStore.updateChat('30', (chat) => { chat.active = { type: 'close-awaiting' }; });
  const lockedCtx = {
    chat: { id: 30 },
    message: { message_id: 301 },
    reply: async (...args) => lockedReplies.push(args),
    answerCbQuery: async () => {},
  };
  await lockedLoop.handleText(lockedCtx, 'Reflection phải sống sót');
  assert.strictEqual(lockedStore.chat(30).pendingReflection.text, 'Reflection phải sống sót');
  assert.strictEqual(lockedStore.chat(30).pendingReflection.messageId, 301);
  assert.strictEqual(lockedStore.chat(30).active?.type, 'confirm', 'P0: preview first, lock only on confirm');
  const lockedCandidate = lockedStore.chat(30).active.candidateId;
  lockedCtx.callbackQuery = { id: 'locked-confirm', data: `dl:confirm:${lockedCandidate}` };
  await lockedLoop.handleCallback(lockedCtx);
  assert(
    lockedReplies.some((args) => args[1]?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.includes('reflection-retry')),
    'lock fail on confirm must offer retry'
  );

  const focusMessages = [];
  calls.length = 0;
  fakeDb.safeQuery = async (sql, params) => {
    calls.push({ sql, params });
    return { ok: true, rows: [] };
  };
  await loop.sendFocusPrompt({ telegram: { sendMessage: async (...args) => focusMessages.push(args) }, chatId: 4 });
  assert(focusMessages[0][1].includes('Em chưa đủ dữ liệu'));
  assert.strictEqual(focusMessages[0][2].reply_markup.inline_keyboard.flat().some((button) => button.callback_data === 'dl:focus-confirm'), false);

  store.updateChat('4', (chat) => { chat.focus = { title: 'Chọn The ONE Thing hôm nay', date: '2026-07-19' }; });
  const focusReplies = [];
  const focusCtx = {
    chat: { id: 4 },
    callbackQuery: { id: 'focus-placeholder', data: 'dl:focus-confirm' },
    answerCbQuery: async () => {},
    reply: async (message) => focusReplies.push(message),
  };
  await loop.handleCallback(focusCtx);
  assert(focusReplies[0].includes('Không có đề xuất đủ bằng chứng'));
  assert.strictEqual(calls.filter((call) => call.sql.includes('daily_loop_upsert_focus')).length, 0);

  store.updateChat('8', (chat) => {
    chat.focus = { title: 'Gọi Phát', date: '2026-07-19', reason: 'due', trustworthy: true, linkedTaskId: 'task-uuid-1' };
  });
  focusCtx.chat.id = 8;
  focusCtx.callbackQuery = { id: 'focus-linked', data: 'dl:focus-confirm' };
  await loop.handleCallback(focusCtx);
  const linkedFocusCall = calls.find((call) => call.sql.includes('daily_loop_upsert_focus') && call.params.includes('task-uuid-1'));
  assert(linkedFocusCall, 'focus confirm must pass linked_task_id');

  store.updateChat('4', (chat) => { chat.focus = { title: 'Việc A', date: '2026-07-19', trustworthy: true }; });
  focusCtx.chat.id = 4;
  focusCtx.callbackQuery = { id: 'focus-replace', data: 'dl:focus-replace' };
  await loop.handleCallback(focusCtx);
  assert.strictEqual(focusReplies.at(-1), 'Vì sao việc này quan trọng hơn?');
  assert.strictEqual(store.chat(4).active.type, 'focus-reason');
  const upsertBeforeCustom = calls.filter((call) => call.sql.includes('daily_loop_upsert_focus')).length;
  await loop.handleText({ chat: { id: 4 }, reply: async () => {} }, 'Việc mới');
  assert.strictEqual(calls.filter((call) => call.sql.includes('daily_loop_upsert_focus')).length, upsertBeforeCustom, 'focus entry must only create preview');

  store.updateChat('5', (chat) => { chat.active = { type: 'weekly-awaiting' }; });
  const weeklyReplies = [];
  await loop.handleText({ chat: { id: 5 }, reply: async (...args) => weeklyReplies.push(args) }, 'Mục tiêu tuần\nBài học');
  assert.strictEqual(calls.filter((call) => call.sql.includes('daily_loop_upsert_weekly')).length, 0, 'weekly entry must only create preview');
  assert.strictEqual(store.chat(5).weekly.raw, 'Mục tiêu tuần\nBài học');

  store.updateChat('9', (chat) => { chat.active = { type: 'close-awaiting' }; });
  const preemptReplies = [];
  await loop.handleText({ chat: { id: 9 }, reply: async (...args) => preemptReplies.push(args) }, 'nhắc anh gọi Phát ngày mai');
  assert(preemptReplies[0][0].includes('Em hiểu'), 'explicit task must preempt close-awaiting reflection');
  assert.strictEqual(store.chat(9).active?.type, 'confirm');

  process.env.DAILY_LOOP_CAPTURE_ENABLED = 'false';
  assert.strictEqual(loop.parseExplicit('nhắc anh gọi Phát ngày mai'), null);
  assert.strictEqual(loop.parseExplicit('đã thiền').type, 'habit');
  process.env.DAILY_LOOP_CAPTURE_ENABLED = 'true';
  process.env.DAILY_LOOP_HABITS_ENABLED = 'false';
  assert.strictEqual(loop.parseExplicit('đã thiền'), null);
  process.env.DAILY_LOOP_FOCUS_ENABLED = 'false';
  process.env.DAILY_LOOP_CLOSE_ENABLED = 'false';
  process.env.DAILY_LOOP_WEEKLY_ENABLED = 'false';
  assert.strictEqual(loop.parseExplicit('/focus'), null);
  assert.strictEqual(loop.parseExplicit('/dongngay'), null);
  assert.strictEqual(loop.parseExplicit('/tuan'), null);
  store.updateChat('6', (chat) => { chat.active = { type: 'weekly-awaiting' }; });
  assert.strictEqual(await loop.handleText({ chat: { id: 6 }, reply: async () => {} }, 'ordinary reply'), false);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✅ Daily Loop tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
