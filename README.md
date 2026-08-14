# 🤖 Unified Telebot (Antigravity + Claude Code + Cursor)

Bot Telegram làm Command Center cho **3 AI Engine** trên cùng máy chủ (Mac Mini):

1. **Antigravity (CDP):** Điều khiển Antigravity IDE qua Chrome DevTools Protocol.
2. **Claude Code (CLI):** `spawn claude -p --output-format stream-json`.
3. **Cursor Agent (CLI):** `spawn agent -p --output-format stream-json` → workspace vault nexmeOS.

---

## ✨ Tính năng cốt lõi

### 🔀 Triple Engine Switching
*   `/engine` hoặc nút **`🔀 Engine`** → Antigravity | Claude Code | **Cursor Agent**.
*   Đổi engine → **reply keyboard đổi theo engine** (không còn menu Anti khi đang Cursor/Claude).
*   **Cursor keyboard:** `📁 workspace` · `🧠 model` · `📊 Status` · `📸 Màn hình` · `🆕 New session` · `🔎 Ask mode` · `🚀 Auto` · `🛠️ Skills` · `🔀 Engine` · `⏹ Stop`
*   **Claude keyboard:** `📁 workspace` · `🧠 model` · `📋 Session` · `📊 Status` · `🆕 New session` · `🔎 Ask mode` · `🔀 Engine` · `⏹ Stop`
*   **Antigravity keyboard:** thread/model · Screen · Artifacts · Skills · Turbo · Engine · Latest
*   `/cursor [prompt]` — one-shot tới Cursor (không cần đổi engine).
*   `/cursor_ask [prompt]` — Cursor read-only (`--mode ask`), không ghi vault / không lấy lock ghi.
*   `/cursor_new` — reset session Cursor.
*   `/cursor_auto` — bật/tắt Auto (`--force`) per chat.
*   `/claude [prompt]` — one-shot tới Claude Code (không cần đổi engine).
*   `/claude_ask [prompt]` — Claude read-only, không ghi vault / không lấy lock ghi.
*   `/claude_new` — reset session Claude.
*   `/help claude` — giải thích menu Claude Code tiếng Việt.
*   `/help cursor` — giải thích menu Cursor tiếng Việt.
*   Cron reply (Brain2) **luôn** về An (Antigravity), không bị lệch theo engine đang chọn.

### 💠 Cursor Agent (CLI)
*   Binary mặc định: `~/.local/bin/agent` (env `CURSOR_BIN`).
*   Workspace mặc định: `~/Projects/nexmeOS` (env `CURSOR_WORK_DIR`).
*   **Model picker (Cursor):** `🧠` / `/model` → 1 trang, model **đang bật** trên Cursor IDE (ID + tiền tố `gcli/...`, `9f/pro/...`); lưu `cursor_model.txt`.
*   **Model picker (Claude Code):** `🧠` / `/model` → 1 trang từ `~/.claude/settings.json` → `models[]` (ID + tiền tố `kr/...`, `gcli/...`); lưu `claude_model.txt`.
*   **Auto mode:** `🚀 Auto` hoặc `/cursor_auto` — ON = `--force` (tự chạy tool); OFF = cẩn thận hơn. State per chat trong `cursor_auto_by_chat.json`.
*   **Screenshot:** `📸 Màn hình` — `screencapture` cửa sổ Cursor hoặc full screen Mac (không phải CDP DOM như Anti).
*   Ghi vault → telebot acquire/release `.nexmeos-lock` (`ai: cursor`).
*   Auth: `agent login` trên Mac Mini **hoặc** `CURSOR_API_KEY` trong `.env`. Chưa login → lỗi graceful (không crash bot).

### 🧠 Claude Code (CLI)
*   Binary mặc định: `claude` (env `CLAUDE_BIN`).
*   Workspace mặc định: `~/Projects/nexmeOS` (env `CLAUDE_WORK_DIR`) — đổi runtime bằng `📁` / `/workspace`.
*   Stream tool events lên Telegram; `/session`, `/stop`.
*   **Ask mode:** `/claude_ask` hoặc nút `🔎 Ask mode` — không ghi vault, không lấy `.nexmeos-lock`.
*   Ghi vault (agent mode) → telebot acquire/release `.nexmeos-lock` (`ai: claude-code`).
*   Prompt luôn prepend vault Human Gate + handoff/context Khôi.
*   Lỗi CLI: giữ stderr tail để debug (không nuốt im).

### 🌐 Antigravity (CDP)
*   Cookie session, Turbo (council đa model), autoaccept, screenshot IDE qua CDP.

---

## 🚀 Cài đặt & Cấu hình

### Yêu cầu
*   Node.js >= 18
*   Antigravity IDE (CDP)
*   (Tuỳ chọn) Claude Code CLI
*   (Tuỳ chọn) Cursor Agent: `curl https://cursor.com/install -fsS | bash` rồi `agent login`
*   macOS Screen Recording permission (cho `📸 Màn hình` Cursor)

### `.env` (xem thêm `.env.example`)
```env
BOT_TOKEN=...
ALLOWED_CHAT_ID=...

CLAUDE_BIN=claude
# Optional override; omit to use ~/Projects/nexmeOS
# CLAUDE_WORK_DIR=/absolute/path/to/workspace
CLAUDE_TIMEOUT=900000

CURSOR_BIN=/Users/congdau/.local/bin/agent
CURSOR_WORK_DIR=/Users/congdau/Projects/nexmeOS
CURSOR_TIMEOUT=900000
CURSOR_FORCE=true   # default Auto ON cho chat mới
# CURSOR_API_KEY=   # hoặc: agent login

AGENT_CDP_PORT=9333
IDE_CDP_PORT=9334
ANTIGRAVITY_PREFERRED_APP=ide
```

### Chạy / restart
```bash
open -a "Antigravity IDE" --args --remote-debugging-port=9334
agent login   # một lần
pm2 start src/telegram-bot.js --name telebot
pm2 restart telebot   # sau khi sửa code
```

---

## 📱 Lệnh Cursor

| Lệnh / Nút | Mô tả |
|---|---|
| `/cursor [prompt]` | Gửi tới Cursor Agent (ghi vault + lock) |
| `/cursor_ask [prompt]` | Read-only ask mode |
| `/cursor_new` | Reset session Cursor |
| `/cursor_auto` | Bật/tắt Auto (`--force`) |
| `/model` hoặc `🧠` | Chọn model Cursor |
| `/screenshot` hoặc `📸 Màn hình` | Chụp cửa sổ Cursor / màn hình Mac |
| `/help cursor` | Hướng dẫn menu Cursor |
| `/engine` → Cursor | Mọi plain text → Cursor |
| `/stop` | Huỷ process Cursor đang chạy |
| `/status` | Model, Auto, session, vault lock |

### Cursor Auto vs Anti Turbo
| | Cursor Auto | Anti Turbo |
|---|---|---|
| Mục đích | Bật `--force` cho 1 agent CLI | Council: Claude plan → Gemini làm → review |
| Nút | `🚀 Auto` | `🚀 Turbo` |
| Engine | Chỉ Cursor | Chỉ Antigravity |

### Hệ thống chung
| Lệnh | Mô tả |
|---|---|
| *(text)* | Gửi tới engine đang chọn |
| `/engine` | Antigravity / Claude / Cursor |
| `/screenshot` | Anti = CDP IDE; Cursor = Mac capture |

---

## 🏗️ Message Router

1. `/cursor*` → luôn Cursor (bypass engine hiện tại).
2. `/claude*` → luôn Claude Code (bypass engine hiện tại).
3. Plain text + `currentEngine === cursor` → `handleCursorQuery` → `cursor-controller.js`.
4. Plain text + `claude` → `handleClaudeQuery` → `claude-controller.js`.
5. Còn lại → Antigravity CDP.
6. Reply cron message → **force Antigravity**.

---

## Daily Glass Stage 0

Daily Loop là router deterministic chạy trước engine, chỉ bắt explicit phrase/command hoặc workflow đang active. Voice được transcribe đúng một lần rồi đi qua router này; input không thuộc Daily Loop giữ routing cũ.

Mặc định toàn bộ flag tắt:

```env
DAILY_LOOP_ENABLED=false
DAILY_LOOP_FOCUS_ENABLED=false
DAILY_LOOP_CLOSE_ENABLED=false
DAILY_LOOP_WEEKLY_ENABLED=false
DAILY_LOOP_CAPTURE_ENABLED=false
DAILY_LOOP_HABITS_ENABLED=false
HOTBRAIN_WORKDIR=/Users/congdau/.nexmeos-supabase
```

Các lệnh/phrase: `/focus`, `/task ...` hoặc `nhắc anh ...`, `đã/chưa <habit>`, `/cham <tên canonical>`, `/dongngay`, `/tuan`.

Trước khi bật:

1. Review schema thật của `tasks` và `interactions`; nếu tên cột khác, chỉ sửa hai function adapter trong `supabase/migrations/20260718_daily_glass_stage0.sql`.
2. Từ linked workdir, chạy migration thủ công: `cd "$HOTBRAIN_WORKDIR" && supabase db query --linked --file /Users/congdau/telebot/supabase/migrations/20260718_daily_glass_stage0.sql`.
3. Chạy `npm run syntax && npm test`.
4. Bật flag từng phần trong `.env`, rồi `pm2 restart telebot --update-env`.
5. Rollback schema (nếu cần): dùng `20260718_daily_glass_stage0_down.sql`. Tắt flag trước khi rollback.

Nếu migration chưa apply hoặc Supabase CLI lỗi, bot giữ candidate/state local và trả cảnh báo; không chuyển input Daily Loop sang AI engine và không crash.

---

*Cập nhật 2026-08-12 — Claude Code ops: vault lock + ask mode + /claude* + prompt context.*
