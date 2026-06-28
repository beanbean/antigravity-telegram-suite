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

const VAULT_DIR = path.join(
  process.env.HOME,
  'Library/Mobile Documents/iCloud~md~obsidian/Documents/BrainCong/Brain2'
);
const HOTBRAIN_QUERY = path.join(VAULT_DIR, 'scripts/hotbrain-query.sh');
const MANIFEST_PATH = path.join(VAULT_DIR, 'scripts/cron/manifest.json');

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
      await bot.telegram.sendMessage(chatId, MSG_03H);
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
      await bot.telegram.sendMessage(chatId, msg);
      updateManifest('06h-focus-today', 'ok');
      renderDashboard();
      console.log('[Brain2Cron] ✓ 06h sent');
    } catch (e) {
      updateManifest('06h-focus-today', 'error');
      console.error('[Brain2Cron] ✗ 06h failed:', e.message);
    }
  });

  // 09h — Phản tư NDD
  scheduleAt(9, 0, async () => {
    try {
      await bot.telegram.sendMessage(chatId, MSG_09H);
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
      await bot.telegram.sendMessage(chatId, MSG_20H);
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

  console.log('[Brain2Cron] ✓ All 4 jobs scheduled (03h, 06h, 09h, 20h)');
}

module.exports = { startBrain2Cron };
