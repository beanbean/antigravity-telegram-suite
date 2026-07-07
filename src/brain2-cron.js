/**
 * Brain2 Cron Module — Scheduled messages for Công Đậu
 *
 * Tích hợp vào telebot. Khi anh reply → engine mặc định (antigravity/An) xử lý.
 *
 * Schedule:
 *   03h — Hỏi điều quan trọng nhất
 *   06h — Query Supabase → ai cần tập trung
 *   09h — Nhắc phản tư NDD
 *   20h — Hỏi kế hoạch ngày mai
 */

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// Track cron messages so we can detect replies
// Map<messageId, {jobId, question, sentAt}>
const cronMessageMap = new Map();

/**
 * Check if a reply_to_message is a Brain2 cron message
 * @returns {object|null} {jobId, question} or null
 */
function isCronReply(replyToMessageId) {
  return cronMessageMap.get(replyToMessageId) || null;
}

/**
 * Build context prefix for An when user replies to a cron message
 */
function buildCronContext(cronInfo, userReply) {
  const CONTEXT_MAP = {
    '03h-important': 'Brain2 Cron hỏi anh Công: "Hôm nay việc quan trọng nhất là gì?" — anh vừa trả lời.',
    '06h-focus-today': 'Brain2 Cron gợi ý ai cần tập trung hôm nay — anh vừa phản hồi.',
    '06h30-morning-radar': 'Brain2 Cron gửi radar followup sáng. Anh reply tên người → soạn tin nhắn chào buổi sáng phù hợp cho người đó, ấm áp, có mention đúng context của họ.',
    '07h-spaced-usage': 'Brain2 Cron bốc 1 atomic note để ôn luyện. Anh reply → dùng concept đó cùng câu chuyện thực tế của anh Công để viết 1 bài insight/content ngắn cho FB hoặc Zalo.',
    '09h-ndd-reflect': 'Brain2 Cron nhắc phản tư NDD sáng — anh vừa gửi kết quả phản tư.',
    '20h-plan-tomorrow': 'Brain2 Cron hỏi kế hoạch ngày mai — anh vừa trả lời.',
  };

  const context = CONTEXT_MAP[cronInfo.jobId] || `Brain2 Cron (${cronInfo.jobId}) — anh vừa trả lời.`;

  return `[Brain2 Cron Context]\n${context}\n\nCâu hỏi gốc:\n"${cronInfo.question}"\n\nTrả lời của anh Công:\n"${userReply}"\n\nHãy xử lý reply này: ghi nhận, lưu vào Brain2 nếu phù hợp, và phản hồi ngắn gọn.`;
}

const VAULT_DIR = path.join(
  process.env.HOME,
  'Library/Mobile Documents/iCloud~md~obsidian/Documents/BrainCong/nexmeOS'
);
const HOTBRAIN_QUERY = path.join(VAULT_DIR, 'scripts/hotbrain-query.sh');
const MANIFEST_PATH = path.join(VAULT_DIR, 'scripts/cron/manifest.json');
const ATOMIC_DIR = path.join(VAULT_DIR, '01-Atomic');
const PEOPLE_DIR = path.join(VAULT_DIR, '01-Atomic/People');
const FRAMEWORKS_DIR = path.join(VAULT_DIR, '01-Atomic/Frameworks');
const SPACED_STATE_FILE = path.join(VAULT_DIR, 'scripts/cron/.spaced-usage-state.json');

// ===== MESSAGES =====

const MSG_03H = `🌅 Chào anh Công — 1 câu hỏi trước khi ngày bắt đầu:

Hôm nay, NẾU chỉ được làm DUY NHẤT 1 việc mà vẫn cảm thấy ngày hôm nay có ý nghĩa — việc đó là gì?

(Trả lời ngắn gọn, em ghi nhận và nhắc lại cuối ngày)`;

const MSG_09H = `🧘 Phản tư NDD sáng nay (5 phút):

1. Hôm nay có bao nhiêu người tham gia?
2. Ai nổi bật / tiến bộ rõ?
3. Mình rút ra 1 insight gì từ buổi sáng nay?

(Trả lời ngắn — em lưu vào Brain2 cho anh)`;

const MSG_20H = `🌙 Anh Công — đóng ngày:

1. Hôm nay việc quan trọng nhất anh đã làm được chưa?
2. Mai anh định tập trung vào điều gì?
3. Có gì cần em (Khôi/An) chuẩn bị sẵn không?

Ngủ ngon anh 🫡`;

// ===== HELPERS =====

function queryHotBrain(sql) {
  return new Promise((resolve, reject) => {
    exec(`bash "${HOTBRAIN_QUERY}" "${sql.replace(/"/g, '\\"')}"`, (err, stdout) => {
      if (err) return reject(err);
      try {
        const data = JSON.parse(stdout);
        resolve(data.rows || []);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function updateManifest(jobId, status) {
  const fs = require('fs');
  try {
    const data = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    const job = data.jobs.find(j => j.id === jobId);
    if (job) {
      job.last_run = new Date().toISOString().replace('T', ' ').slice(0, 19);
      job.last_status = status;
    }
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[Brain2Cron] Failed to update manifest:', e.message);
  }
}

function renderDashboard() {
  exec(`bash "${path.join(VAULT_DIR, 'scripts/render-crm-dashboard.sh')}"`, (err) => {
    if (err) console.error('[Brain2Cron] Dashboard render failed:', err.message);
    else console.log('[Brain2Cron] Dashboard rendered');
  });
}

// ===== SPACED USAGE: 07h =====

function loadSpacedState() {
  try {
    if (fs.existsSync(SPACED_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(SPACED_STATE_FILE, 'utf-8'));
    }
  } catch (e) {}
  return { lastConcepts: [], lastStories: [] };
}

function saveSpacedState(state) {
  try {
    fs.writeFileSync(SPACED_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[Brain2Cron] Failed to save spaced state:', e.message);
  }
}

// BUG1 FIX: đọc đúng thư mục cụ thể thay vì root ATOMIC_DIR
function pickFromDir(dirPath, excludeNames) {
  try {
    const files = fs.readdirSync(dirPath).filter(f =>
      f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('.')
    );
    const candidates = files.filter(f => !excludeNames.includes(f));
    if (!candidates.length) {
      // All excluded → reset dedup and pick fresh
      const fresh = files.filter(f => !f.startsWith('_'));
      if (!fresh.length) return null;
      return fresh[Math.floor(Math.random() * fresh.length)];
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
  } catch (e) {
    console.error('[Brain2Cron] pickFromDir error:', e.message, dirPath);
    return null;
  }
}

function getExcerpt(filePath, maxChars = 200) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const body = raw.replace(/^---[\s\S]*?---\n/, '').trim();
    const clean = body.replace(/^#{1,6}\s+/gm, '').trim();
    return clean.slice(0, maxChars) + (clean.length > maxChars ? '…' : '');
  } catch (e) {
    return '';
  }
}

async function build07hMessage() {
  const state = loadSpacedState();

  // BUG2 FIX: bốc 2 notes riêng biệt — Concept/Insight + Story
  // Concept: ưu tiên Insights, fallback Concepts
  const insightsDir = path.join(ATOMIC_DIR, 'Insights');
  const conceptsDir = path.join(ATOMIC_DIR, 'Concepts');
  const storiesDir = path.join(ATOMIC_DIR, 'Stories');

  let conceptFile = pickFromDir(insightsDir, state.lastConcepts || []);
  let conceptDir = insightsDir;
  if (!conceptFile) {
    conceptFile = pickFromDir(conceptsDir, state.lastConcepts || []);
    conceptDir = conceptsDir;
  }

  const storyFile = pickFromDir(storiesDir, state.lastStories || []);

  if (!conceptFile && !storyFile) {
    return { msg: '📚 [Spaced Usage] Không tìm được note để ôn hôm nay.', concept: '', story: '' };
  }

  // Update dedup buffers (keep last 7 each)
  const newState = {
    lastConcepts: conceptFile
      ? [...(state.lastConcepts || []), conceptFile].slice(-7)
      : (state.lastConcepts || []),
    lastStories: storyFile
      ? [...(state.lastStories || []), storyFile].slice(-7)
      : (state.lastStories || []),
  };
  saveSpacedState(newState);

  const conceptName = conceptFile ? conceptFile.replace(/\.md$/, '') : '';
  const storyName = storyFile ? storyFile.replace(/\.md$/, '') : '';
  const conceptExcerpt = conceptFile ? getExcerpt(path.join(conceptDir, conceptFile)) : '';
  const storyExcerpt = storyFile ? getExcerpt(path.join(storiesDir, storyFile)) : '';

  let msg = `📚 *Spaced Usage — ôn lại tri thức cũ* 🧠\n\n`;

  if (conceptName) {
    msg += `💡 *Concept/Insight:*\n_${conceptName}_\n${conceptExcerpt}\n\n`;
  }
  if (storyName) {
    msg += `📖 *Story:*\n_${storyName}_\n${storyExcerpt}\n\n`;
  }

  msg += `——\n💬 Reply tin này → em ghép Concept + Story thành bài insight/content cho FB hoặc Zalo.`;

  return { msg, conceptName, storyName, conceptExcerpt, storyExcerpt };
}

// ===== MORNING RADAR: 06h30 =====

async function buildMorningRadar() {
  try {
    // Query people with followup today
    const followup = await queryHotBrain(`
      SELECT id, name, next_followup, relationship_type, notes
      FROM people
      WHERE next_followup IS NOT NULL AND next_followup <= CURRENT_DATE
      ORDER BY next_followup ASC LIMIT 5
    `);

    if (!followup.length) {
      return { msg: null }; // Nothing to radar today
    }

    // Pick random framework hint from Frameworks dir
    let frameworkHint = '';
    try {
      const frameworks = fs.readdirSync(FRAMEWORKS_DIR).filter(f => f.endsWith('.md'));
      if (frameworks.length) {
        const randFramework = frameworks[Math.floor(Math.random() * frameworks.length)];
        const fwName = randFramework.replace(/\.md$/, '').replace(/^[a-z-]+-framework-/, '').replace(/-/g, ' ');
        frameworkHint = `\n\n💡 Framework hôm nay: *${fwName}* — dùng khi gặp họ.`;
      }
    } catch (e) {}

    const lines = ['🎯 *Radar trước trận đánh* — followup hôm nay:\n'];

    for (const person of followup) {
      // Try to find People note for narrative
      let narrative = '';
      try {
        const peopleFiles = fs.readdirSync(PEOPLE_DIR);
        const match = peopleFiles.find(f =>
          f.toLowerCase().includes(person.name.toLowerCase().split(' ').pop()) ||
          f.toLowerCase().replace(/[^a-z0-9]/g, '').includes(
            person.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-4)
          )
        );
        if (match) {
          narrative = getExcerpt(path.join(PEOPLE_DIR, match), 120);
        }
      } catch (e) {}

      lines.push(`👤 *${person.name}* (${person.relationship_type}) — hạn ${person.next_followup}`);
      if (narrative) lines.push(`   _${narrative}_`);
    }

    const msg = lines.join('\n') + frameworkHint +
      '\n\n——\n💬 Reply tên ai để em soạn tin nhắn chào buổi sáng gửi người đó.';

    return { msg, people: followup };
  } catch (e) {
    console.error('[Brain2Cron] Morning radar failed:', e.message);
    return { msg: null };
  }
}

// ===== DYNAMIC MESSAGE: 06h =====

async function build06hMessage() {
  try {
    const followup = await queryHotBrain(`
      SELECT name, next_followup, relationship_type
      FROM people
      WHERE next_followup IS NOT NULL AND next_followup <= CURRENT_DATE
      ORDER BY next_followup ASC LIMIT 3
    `);

    const newMembers = await queryHotBrain(`
      SELECT p.name, c.txn_date, c.amount
      FROM cashflow c JOIN people p ON c.person_id = p.id
      WHERE c.txn_type = 'income' AND c.txn_date >= CURRENT_DATE - INTERVAL '7 days'
      ORDER BY c.txn_date DESC LIMIT 3
    `);

    let lines = [];

    if (newMembers.length) {
      lines.push('🌟 Hội viên mới (cần chăm sóc đặc biệt):');
      for (const m of newMembers) {
        const amt = Number(m.amount).toLocaleString('vi-VN') + 'đ';
        lines.push(`  • ${m.name} — ${amt} (${m.txn_date})`);
      }
    }

    if (followup.length) {
      lines.push('');
      lines.push('📞 Cần followup hôm nay:');
      for (const f of followup) {
        lines.push(`  • ${f.name} (${f.relationship_type}) — hạn ${f.next_followup}`);
      }
    }

    if (!lines.length) {
      lines.push('Không có ai đặc biệt cần tập trung. Ngày tự do!');
    }

    return `☀️ Anh Công — hôm nay tập trung vào:\n\n${lines.join('\n')}\n\nChúc anh một ngày hiệu quả 💪`;
  } catch (e) {
    console.error('[Brain2Cron] 06h query failed:', e.message);
    return `☀️ Anh Công — chúc anh ngày hiệu quả!\n\n(⚠️ Query Supabase lỗi: ${e.message})`;
  }
}

// ===== SCHEDULER =====

/**
 * Send a test cron message (for debugging reply flow)
 */
async function sendTestCron(bot) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const testMsg = '🧪 [Brain2 Cron Test] Hôm nay việc quan trọng nhất là gì?\n\n(Reply tin này để test — An sẽ mở chat mới và hiểu context)';
  const sent = await bot.telegram.sendMessage(chatId, testMsg);
  cronMessageMap.set(sent.message_id, { jobId: '03h-important', question: testMsg, sentAt: new Date() });
  console.log(`[Brain2Cron] Test message sent, id=${sent.message_id}`);
  return sent;
}

function scheduleAt(hour, minute, callback) {
  const check = () => {
    const now = new Date();
    if (now.getHours() === hour && now.getMinutes() === minute) {
      callback();
    }
  };
  // Check every 60s
  setInterval(check, 60000);
  console.log(`[Brain2Cron] Scheduled job at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
}

// ===== EXPORT: startBrain2Cron(bot) =====

function startBrain2Cron(bot) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    console.warn('[Brain2Cron] No TELEGRAM_CHAT_ID — disabled');
    return;
  }

  console.log('[Brain2Cron] Starting Brain2 scheduled messages...');

  // 03h — Hỏi điều quan trọng nhất
  scheduleAt(3, 0, async () => {
    try {
      const sent = await bot.telegram.sendMessage(chatId, MSG_03H);
      cronMessageMap.set(sent.message_id, { jobId: '03h-important', question: MSG_03H, sentAt: new Date() });
      updateManifest('03h-important', 'ok');
      console.log('[Brain2Cron] ✓ 03h sent');
    } catch (e) {
      updateManifest('03h-important', 'error');
      console.error('[Brain2Cron] ✗ 03h failed:', e.message);
    }
  });

  // 06h — Dynamic query + render dashboard
  scheduleAt(6, 0, async () => {
    try {
      const msg = await build06hMessage();
      const sent = await bot.telegram.sendMessage(chatId, msg);
      cronMessageMap.set(sent.message_id, { jobId: '06h-focus-today', question: msg, sentAt: new Date() });
      updateManifest('06h-focus-today', 'ok');
      renderDashboard();
      console.log('[Brain2Cron] ✓ 06h sent');
    } catch (e) {
      updateManifest('06h-focus-today', 'error');
      console.error('[Brain2Cron] ✗ 06h failed:', e.message);
    }
  });

  // 06h30 — Morning Radar (followup + People note + framework hint)
  scheduleAt(6, 30, async () => {
    try {
      const { msg, people } = await buildMorningRadar();
      if (!msg) {
        console.log('[Brain2Cron] 06h30 radar: không có followup hôm nay, skip');
        updateManifest('06h30-morning-radar', 'skip');
        return;
      }
      const sent = await bot.telegram.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      cronMessageMap.set(sent.message_id, {
        jobId: '06h30-morning-radar',
        question: msg,
        sentAt: new Date(),
        people: (people || []).map(p => p.name),
      });
      updateManifest('06h30-morning-radar', 'ok');
      console.log('[Brain2Cron] ✓ 06h30 radar sent');
    } catch (e) {
      updateManifest('06h30-morning-radar', 'error');
      console.error('[Brain2Cron] ✗ 06h30 radar failed:', e.message);
    }
  });

  // 07h — Spaced Usage (Concept/Insight + Story, dedup, 2-way tracking)
  scheduleAt(7, 0, async () => {
    try {
      const { msg, conceptName, storyName, conceptExcerpt, storyExcerpt } = await build07hMessage();
      const sent = await bot.telegram.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      cronMessageMap.set(sent.message_id, {
        jobId: '07h-spaced-usage',
        question: msg,
        sentAt: new Date(),
        conceptName,
        storyName,
        conceptExcerpt,
        storyExcerpt,
      });
      updateManifest('07h-spaced-usage', 'ok');
      console.log(`[Brain2Cron] ✓ 07h spaced usage sent: ${conceptName} + ${storyName}`);
    } catch (e) {
      updateManifest('07h-spaced-usage', 'error');
      console.error('[Brain2Cron] ✗ 07h spaced usage failed:', e.message);
    }
  });

  // 09h — Phản tư NDD
  scheduleAt(9, 0, async () => {
    try {
      const sent = await bot.telegram.sendMessage(chatId, MSG_09H);
      cronMessageMap.set(sent.message_id, { jobId: '09h-ndd-reflect', question: MSG_09H, sentAt: new Date() });
      updateManifest('09h-ndd-reflect', 'ok');
      console.log('[Brain2Cron] ✓ 09h sent');
    } catch (e) {
      updateManifest('09h-ndd-reflect', 'error');
      console.error('[Brain2Cron] ✗ 09h failed:', e.message);
    }
  });

  // 20h — Kế hoạch ngày mai
  scheduleAt(20, 0, async () => {
    try {
      const sent = await bot.telegram.sendMessage(chatId, MSG_20H);
      cronMessageMap.set(sent.message_id, { jobId: '20h-plan-tomorrow', question: MSG_20H, sentAt: new Date() });
      updateManifest('20h-plan-tomorrow', 'ok');
      console.log('[Brain2Cron] ✓ 20h sent');
    } catch (e) {
      updateManifest('20h-plan-tomorrow', 'error');
      console.error('[Brain2Cron] ✗ 20h failed:', e.message);
    }
  });

  // 06:05 — Render dashboard (riêng, đảm bảo chạy kể cả 06h query fail)
  scheduleAt(6, 5, () => {
    renderDashboard();
    updateManifest('06h-render-dashboard', 'ok');
  });

  console.log('[Brain2Cron] ✓ All 6 jobs scheduled (03h, 06h, 06h30-radar, 07h-spaced, 09h, 20h)');
}

module.exports = { startBrain2Cron, isCronReply, buildCronContext, sendTestCron };
