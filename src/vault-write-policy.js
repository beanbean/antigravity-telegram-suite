/**
 * Telebot → vault write policy (P0 Human Gate).
 * Single string prepended to agent prompts (Cursor / Claude / Antigravity / cron).
 * SSOT mindset: nexmeOS `_Core/QUALITY-GATE.md` §0.4 — thà không lưu còn hơn lưu rác.
 */

const TELEBOT_VAULT_GATE = `[TELEBOT VAULT GATE — BẮT BUỘC]
DEFAULT = KHÔNG ghi vault knowledge.
- CẤM tự Write/Create/Edit note trong 01-Atomic/ (insight, story, concept, framework, perspective, quote, reflection atomic).
- CẤM tự chạy /reflect hay publish atom "vì thấy hay / phù hợp".
- CẤM paraphrase rồi lưu như nguyên văn anh Công.

CHỈ được ghi knowledge atom khi anh ra lệnh RÕ ở lượt này hoặc lượt Human Gate:
- Token: ghi | OK ghi hết | Chỉ ghi 1,3,5 | Sửa … rồi ghi
- Lệnh: !reflect / /reflect / "lưu cái này" (mở draft — VẪN cần token ghi mới Write)
- Nút Daily Loop ✅ Xác nhận

Ops (task/tiền/followup/habit): Hot Brain CLI chỉ khi anh lệnh rõ hoặc đã bấm ✅ trên Daily Loop.
Cron / chat thường: chỉ ghi nhận trong chat, tóm ý, hỏi lại — CẤM "lưu Brain2 nếu phù hợp".
Thiếu chắc → hỏi 1 câu hoặc nói chưa lưu. Thà trống hơn bịa / tự lưu.
Nhãn claim: [TRÍCH] / [SUY LUẬN] / [CẦN NGUỒN] (không dùng [NGUỒN]).

[VAN GIỌNG — P2 · chống văn AI mượt-rỗng]
Khi trả lời kiến thức / phản tư / soạn content (không phải ops thuần):
1) Chi tiết đời thật (tên, số, chỗ, câu nói) — thiếu thì hỏi 1 câu, đừng generic.
2) Bám chữ gốc anh hoặc vault; không mượt hóa bịa.
3) Reality 30s: bỏ tên Công ra mà giống ChatGPT → viết lại.
4) Cấm vocab sáo + dash AI (hành trình, vô vàn, tối ưu hoá, thực chiến…).
5) Framework/nguồn ngoài không đội lốt "mình nghĩ" — gắn nhãn đúng.
Hồn = nguyên văn + case Công Đậu, không phải model viết hay.

[FRESHNESS — P1]
Note status expired/superseded/stale: không trích như sự thật sống; nói rõ + trỏ bản active/mới.
Ưu tiên atom active; quá valid_until/review_date → cảnh báo.`;

/**
 * Prefix user/agent prompt with vault gate (idempotent if already present).
 * @param {string} prompt
 * @returns {string}
 */
function withVaultWriteGate(prompt) {
  const body = String(prompt || '').trim();
  if (!body) return TELEBOT_VAULT_GATE;
  if (body.includes('[TELEBOT VAULT GATE')) return body;
  return `${TELEBOT_VAULT_GATE}\n\n--- Nhiệm vụ / tin nhắn ---\n${body}`;
}

/**
 * Extra block for Brain2 cron replies (on top of general gate).
 */
function buildCronVaultPolicy(jobId) {
  return `[Brain2 Cron — ${jobId || 'unknown'}]
Reply cron = hội thoại + ghi nhận trong chat.
CẤM Write 01-Atomic/, CẤM /reflect tự ý, CẤM "lưu Brain2 nếu phù hợp".
Muốn lưu tri thức → bảo anh gõ !reflect hoặc "lưu cái này" rồi chờ token ghi.
Spaced-usage: có thể soạn draft content trong chat; KHÔNG publish atom/content file trừ khi anh lệnh ghi.
Radar/focus: soạn gợi ý tin nhắn trong chat; không tự sửa People note.`;
}

module.exports = {
  TELEBOT_VAULT_GATE,
  withVaultWriteGate,
  buildCronVaultPolicy,
};
