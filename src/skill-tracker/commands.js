const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { runAudit } = require('./audit');
const { formatMessage, renderAuditReport } = require('./render');

const registryPath = path.join(__dirname, '..', '..', 'data', 'registry.yaml');

// Bộ nhớ đệm đơn giản để lưu trạng thái chat của user
// Cấu trúc: { [chatId]: { step: 'awaiting_dungthat', pendingSkillId: '...' } }
const userState = {};

function loadRegistry() {
  return yaml.load(fs.readFileSync(registryPath, 'utf8'));
}

function saveRegistry(data) {
  fs.writeFileSync(registryPath, yaml.dump(data));
}

function setupSkillTrackerCommands(bot) {
  
  // Middleware đánh chặn tin nhắn text khi đang chờ nhập mô tả /dungthat
  bot.use(async (ctx, next) => {
    if (!ctx.message || !ctx.message.text) return next();
    
    // Đảm bảo không cản đường các lệnh có gạch chéo
    if (ctx.message.text.startsWith('/')) return next();
    
    const chatId = ctx.chat.id.toString();
    const state = userState[chatId];
    
    if (state && state.step === 'awaiting_dungthat') {
      const desc = ctx.message.text;
      const skillId = state.pendingSkillId;
      
      if (desc.trim().length < 5) {
        return ctx.reply("Mô tả ngắn quá, anh nhập lại chi tiết hơn một chút được không?");
      }

      const reg = loadRegistry();
      const skill = reg.skills.find(s => s.id === skillId);
      
      if (skill) {
        skill.trang_thai = 'dang_su_dung';
        const today = new Date().toISOString().split('T')[0];
        skill.ngay_dung_that = today;
        skill.nhat_ky = skill.nhat_ky || [];
        skill.nhat_ky.push(`[${today}] Sản phẩm thật: ${desc}`);
        saveRegistry(reg);
        
        // Xoá state
        delete userState[chatId];
        
        await ctx.reply(formatMessage`Tuyệt vời! Đã ghi nhận sản phẩm thật và chuyển ${skillId} sang Đang sử dụng.`);
      } else {
        delete userState[chatId];
        await ctx.reply("Lỗi: Không tìm thấy skill đang chờ. Đã huỷ thao tác.");
      }
      return; // Nuốt tin nhắn này, không cho đi tiếp xuống Claude/Cursor
    }
    
    return next();
  });

  bot.command('trangthai', async (ctx) => {
    const reg = loadRegistry();
    let msg = formatMessage`=== TRẠNG THÁI SKILLS ===\n\n`;
    
    reg.skills.forEach(s => {
      msg += `• ${s.id} (${s.ten})\n  Trạng thái: ${s.trang_thai}\n\n`;
    });

    const unfinished = reg.viec.filter(v => !v.xong);
    msg += formatMessage`=== VIỆC CÒN TREO ===\n`;
    if (unfinished.length === 0) {
      msg += "Tuyệt vời, không còn việc nào treo!";
    } else {
      unfinished.forEach(v => {
        msg += `• [${v.id}] ${v.ten} (Hạn: ${v.han})\n`;
      });
    }

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  bot.command('xong', async (ctx) => {
    const taskId = (ctx.payload || '').trim(); // Telegraf lưu argument trong ctx.payload
    if (!taskId) return ctx.reply("Anh cần nhập mã việc, ví dụ: /xong v1");

    const reg = loadRegistry();
    const task = reg.viec.find(v => v.id === taskId);
    
    if (!task) return ctx.reply(formatMessage`Không tìm thấy việc mã ${taskId}.`);
    if (task.xong) return ctx.reply(formatMessage`Việc ${taskId} đã được đánh dấu xong từ trước rồi anh.`);

    task.xong = true;
    saveRegistry(reg);
    await ctx.reply(formatMessage`Đã đánh dấu xong việc ${taskId}. Tuyệt vời!`);
  });

  bot.command('dungthat', async (ctx) => {
    const skillId = (ctx.payload || '').trim();
    if (!skillId) return ctx.reply("Anh cần nhập ID skill, ví dụ: /dungthat voice-dna");

    const reg = loadRegistry();
    const skill = reg.skills.find(s => s.id === skillId);
    
    if (!skill) return ctx.reply(formatMessage`Không tìm thấy skill ${skillId}.`);

    const chatId = ctx.chat.id.toString();
    userState[chatId] = { step: 'awaiting_dungthat', pendingSkillId: skillId };
    
    await ctx.reply(formatMessage`Để chuyển ${skillId} sang Đang sử dụng, anh cho em biết: Sản phẩm thật là gì? (Trả lời một dòng mô tả)`);
  });

  bot.command('luutru', async (ctx) => {
    const text = (ctx.payload || '').trim();
    const parts = text.split(' ');
    const skillId = parts[0];
    const reason = parts.slice(1).join(' ');

    if (!skillId || !reason) {
      return ctx.reply("Cú pháp: /luutru <skill_id> <ly_do>");
    }

    const reg = loadRegistry();
    const skill = reg.skills.find(s => s.id === skillId);
    if (!skill) return ctx.reply(formatMessage`Không tìm thấy skill ${skillId}.`);

    skill.trang_thai = 'luu_tru';
    skill.nhat_ky = skill.nhat_ky || [];
    skill.nhat_ky.push(`[${new Date().toISOString()}] Đã lưu trữ: ${reason}`);
    saveRegistry(reg);
    
    await ctx.reply(formatMessage`Đã chuyển skill ${skillId} sang Lưu trữ. Lý do: ${reason}`);
  });

  bot.command('ratsoat', async (ctx) => {
    const reg = loadRegistry();
    const auditResult = runAudit();
    if (!auditResult) return ctx.reply("Có lỗi khi đọc sổ.");
    
    const studyingSkills = reg.skills
      .filter(s => s.trang_thai === 'dang_nghien_cuu')
      .map(s => ({ ten: s.ten, daysIdle: 0 }));
      
    const msg = renderAuditReport(auditResult, studyingSkills);
    await ctx.reply(msg);
  });

  bot.command('themskill', async (ctx) => {
    const reg = loadRegistry();
    const dangNghienCuu = reg.skills.filter(s => s.trang_thai === 'dang_nghien_cuu');
    if (dangNghienCuu.length >= 2) {
      return ctx.reply(formatMessage`Đang có ${dangNghienCuu.length} skill chưa dùng thật. Giải quyết xong mới được cài thêm.`);
    }
    await ctx.reply("Anh có thể tự thêm block mới vào file `data/registry.yaml` nhé.");
  });

  // Đăng ký hành động (action) cho các nút inline
  bot.action(/ext_3_(.+)/, async (ctx) => {
    const taskId = ctx.match[1];
    const reg = loadRegistry();
    const task = reg.viec.find(v => v.id === taskId);
    if (task) {
      const now = new Date();
      now.setDate(now.getDate() + 3);
      task.han = now.toISOString().split('T')[0];
      saveRegistry(reg);
      await ctx.answerCbQuery("Đã gia hạn thêm 3 ngày");
      await ctx.editMessageText(formatMessage`Đã gia hạn việc "${task.ten}" thêm 3 ngày. Quyết tâm kết nạp skill này nha anh!`);
    } else {
      await ctx.answerCbQuery("Không tìm thấy việc này");
    }
  });

  bot.action(/arc_(.+)/, async (ctx) => {
    const skillId = ctx.match[1];
    const reg = loadRegistry();
    const skill = reg.skills.find(s => s.id === skillId);
    if (skill) {
      skill.trang_thai = 'luu_tru';
      skill.nhat_ky = skill.nhat_ky || [];
      skill.nhat_ky.push(`[${new Date().toISOString().split('T')[0]}] Lưu trữ tự động vì quá hạn.`);
      
      reg.viec = reg.viec.filter(v => !(v.skill_id === skillId && !v.xong));
      saveRegistry(reg);
      
      await ctx.answerCbQuery("Đã chuyển sang Lưu trữ");
      await ctx.editMessageText(formatMessage`Đã cất skill ${skillId} vào kho Lưu trữ để dọn dẹp bộ nhớ.`);
    } else {
      await ctx.answerCbQuery("Không tìm thấy skill");
    }
  });
}

module.exports = {
  setupSkillTrackerCommands
};
