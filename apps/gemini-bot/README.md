# Gemini CLI via Telegram

Use Gemini CLI from Telegram through a dedicated local bot.

## Current scope

- Separate Telegram bot from the existing OpenCode bot
- Text chat with Gemini CLI
- Streaming draft updates from Gemini stdout
- Per-chat local session history
- `/new`, `/status`, `/models`, `/model`, `/stop`
- Structured logs with file/line + chat/session correlation

## Not in the first build

- OpenCode-style project switching
- Share/unshare
- Undo/redo
- Interactive permission flow
- Rich attachment support

## Quick start

```bash
cp .env.example .env
bun install
bun run start
```

Set at least:

```env
TELEGRAM_BOT_TOKEN="123456:your-bot-token"
ALLOWED_USER_ID="123456789"
```

## Runtime files

- `sessions-map.json`
- `selected-models.json`
- `chat-histories.json`
- `.telegram-bridge.lock`
- `logs/bridge.log`
- `logs/error.log`
