"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.startCronJobs = startCronJobs;
const telegraf_1 = require("telegraf");
const cron = require("node-cron");
const db_1 = require("./db");
const dotenv = __importStar(require("dotenv"));
dotenv.config({ override: true });
// Giờ chạy cảnh báo thẻ cố định mỗi ngày (mặc định 08:00). Đổi qua env FINANCE_ALERT_CRON nếu cần.
const ALERT_CRON = process.env.FINANCE_ALERT_CRON || '0 8 * * *';
// NOTE: Dùng bot instance từ main (giống Brain2Cron), không tự tạo Telegram instance.
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
function startCronJobs(bot) {
    if (!bot || !bot.telegram) {
        console.warn('⚠️ finance/cron: bot instance chưa sẵn sàng — disabled.');
        return;
    }
    if (!CHAT_ID) {
        console.warn('⚠️ TELEGRAM_CHAT_ID chưa có — finance cron disabled.');
        return;
    }
    const telegram = bot.telegram;
    // Hàm chạy kiểm tra
    async function checkAlerts() {
        console.log('Đang chạy kiểm tra cảnh báo tự động...');
        try {
            const cards = await (0, db_1.getCreditCards)();
            const today = new Date();
            const currentDay = today.getDate();
            for (const card of cards) {
                // 1. Cảnh báo sắp chốt sao kê (trước 1 ngày)
                let statementWarningDay = card.statement_date - 1;
                if (statementWarningDay === 0)
                    statementWarningDay = 30; // Xử lý tạm ngày đầu tháng
                if (currentDay === statementWarningDay) {
                    await telegram.sendMessage(CHAT_ID, `⚠️ <b>CẢNH BÁO SAO KÊ</b>\nNgày mai (mùng ${card.statement_date}) là ngày chốt sao kê của thẻ <b>${card.name}</b>.\nAnh cân nhắc tạm dừng chi tiêu thẻ này hôm nay để không bị dồn nợ sang kỳ tới nhé!`, { parse_mode: 'HTML' });
                }
                // 2. Cảnh báo sắp đến hạn thanh toán (trước 3 ngày và trước 1 ngày)
                let dueWarningDay3 = card.due_date - 3;
                let dueWarningDay1 = card.due_date - 1;
                if (currentDay === dueWarningDay3) {
                    await telegram.sendMessage(CHAT_ID, `🚨 <b>NHẮC NHỞ THANH TOÁN</b>\nCòn 3 ngày nữa (mùng ${card.due_date}) là hạn chót thanh toán thẻ <b>${card.name}</b>.\nAnh nhớ chuẩn bị tiền hoặc gửi em ảnh hóa đơn nếu đã thanh toán nhé!`, { parse_mode: 'HTML' });
                }
                else if (currentDay === dueWarningDay1) {
                    await telegram.sendMessage(CHAT_ID, `🔥 <b>KHẨN CẤP: HẠN THANH TOÁN</b>\nNgày mai (mùng ${card.due_date}) là ngày cuối cùng phải thanh toán thẻ <b>${card.name}</b>!\nThanh toán ngay để tránh bị phạt và lưu vết nợ xấu anh nhé!`, { parse_mode: 'HTML' });
                }
                else if (currentDay === card.due_date) {
                    await telegram.sendMessage(CHAT_ID, `💀 <b>HÔM NAY LÀ HẠN CHÓT</b>\nAnh đã thanh toán thẻ <b>${card.name}</b> chưa? Nếu chưa thì xử lý ngay lập tức nhé!`, { parse_mode: 'HTML' });
                }
            }
        }
        catch (error) {
            console.error('Lỗi khi chạy cron job:', error);
        }
    }
    // Neo vào giờ cố định mỗi ngày (không chạy lúc start để tránh spam khi restart,
    // và không trôi giờ theo setInterval). Timezone Asia/Ho_Chi_Minh.
    if (!cron.validate(ALERT_CRON)) {
        console.error(`⚠️ FINANCE_ALERT_CRON không hợp lệ: "${ALERT_CRON}" — dùng mặc định 0 8 * * *`);
    }
    const schedule = cron.validate(ALERT_CRON) ? ALERT_CRON : '0 8 * * *';
    cron.schedule(schedule, checkAlerts, { timezone: 'Asia/Ho_Chi_Minh' });
    console.log(`Đã kích hoạt nhắc nợ thẻ tự động theo lịch "${schedule}" (Asia/Ho_Chi_Minh).`);
}
