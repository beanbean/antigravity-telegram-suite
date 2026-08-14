const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { runAudit } = require('./audit');
const { renderMorningReminder, renderOverdueWarning, renderAuditReport } = require('./render');

const registryPath = path.join(__dirname, '..', '..', 'data', 'registry.yaml');

function loadRegistry() {
  try {
    const content = fs.readFileSync(registryPath, 'utf8');
    return yaml.load(content);
  } catch (e) {
    console.error('[skill-tracker] Lỗi đọc registry:', e);
    return null;
  }
}

function parseDate(dateStr) {
  return new Date(dateStr);
}

function diffDays(date1, date2) {
  const diffTime = Math.abs(date2.getTime() - date1.getTime());
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

// Hàm hỗ trợ gửi tin cho ALLOWED_CHAT_ID (giả định dùng chatId đầu tiên trong list)
async function sendToMainChat(bot, text, replyMarkup) {
  const chatId = process.env.ALLOWED_CHAT_ID ? process.env.ALLOWED_CHAT_ID.split(',')[0].trim() : null;
  if (!chatId) {
    console.error('[skill-tracker] Thiếu ALLOWED_CHAT_ID, không thể gửi lịch.');
    return;
  }
  try {
    const opts = { parse_mode: 'Markdown' };
    if (replyMarkup) opts.reply_markup = replyMarkup;
    await bot.telegram.sendMessage(chatId, text, opts);
  } catch (e) {
    console.error('[skill-tracker] Lỗi gửi tin:', e.message);
  }
}

function startSkillTrackerCron(bot) {
  // 1. NHẮC SÁNG, 07:00 mỗi ngày
  cron.schedule('0 7 * * *', async () => {
    const registry = loadRegistry();
    if (!registry) return;
    
    const unfinished = registry.viec.filter((v) => !v.xong);
    if (unfinished.length === 0) return;

    const now = new Date();
    
    unfinished.sort((a, b) => {
      const da = parseDate(a.han);
      const db = parseDate(b.han);
      const isAOverdue = da < now ? 1 : 0;
      const isBOverdue = db < now ? 1 : 0;
      
      if (isAOverdue !== isBOverdue) return isBOverdue - isAOverdue;
      if (da.getTime() !== db.getTime()) return da.getTime() - db.getTime();
      if (a.loai === 'dung_that' && b.loai !== 'dung_that') return -1;
      if (b.loai === 'dung_that' && a.loai !== 'dung_that') return 1;
      return 0;
    });

    const topTask = unfinished[0];
    const skill = registry.skills.find((s) => s.id === topTask.skill_id);
    const text = renderMorningReminder(topTask, skill);
    await sendToMainChat(bot, text);
  }, { timezone: "Asia/Saigon" });

  // 2. CẢNH BÁO QUÁ HẠN, 20:30 mỗi ngày
  cron.schedule('30 20 * * *', async () => {
    const registry = loadRegistry();
    if (!registry) return;

    const unfinished = registry.viec.filter((v) => !v.xong);
    const now = new Date();

    for (const v of unfinished) {
      const d = parseDate(v.han);
      if (d < now) {
        const daysOverdue = diffDays(d, now);
        const isDungThat = v.loai === 'dung_that';
        const requireDecision = isDungThat && daysOverdue > 3;
        const text = renderOverdueWarning(v, daysOverdue, requireDecision);
        
        let keyboard;
        if (requireDecision) {
          keyboard = {
            inline_keyboard: [[
              { text: "Làm trong 3 ngày", callback_data: `ext_3_${v.id}` },
              { text: "Chuyển Lưu trữ", callback_data: `arc_${v.skill_id}` }
            ]]
          };
        }
        await sendToMainChat(bot, text, keyboard);
      }
    }
  }, { timezone: "Asia/Saigon" });

  // 3. BÁO CÁO RÀ SOÁT, 09:00 Chủ nhật (0 là Chủ nhật)
  cron.schedule('0 9 * * 0', async () => {
    const registry = loadRegistry();
    if (!registry) return;

    const auditResult = runAudit();
    if (!auditResult) return;

    const studyingSkills = registry.skills
      .filter((s) => s.trang_thai === 'dang_nghien_cuu')
      .map((s) => {
        let daysIdle = 0;
        const t = registry.viec.find((v) => v.skill_id === s.id && v.loai === 'cai');
        if (t && t.han) {
           daysIdle = diffDays(parseDate(t.han), new Date());
        }
        return { ten: s.ten, daysIdle };
      });

    const text = renderAuditReport(auditResult, studyingSkills);
    await sendToMainChat(bot, text);
  }, { timezone: "Asia/Saigon" });

  console.log('[skill-tracker] Đã khởi tạo các cron jobs (07:00, 20:30, Sun 09:00).');
}

module.exports = {
  startSkillTrackerCron
};
