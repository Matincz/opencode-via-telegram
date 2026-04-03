# Codex via Telegram

Use OpenAI Codex CLI from Telegram through a dedicated local bot.

## Current scope

- Separate Telegram bot from Gemini/OpenCode bots
- Text chat with Codex CLI
- Native Codex session resume via `codex exec resume`
- Per-chat local session mapping
- `/new`, `/status`, `/models`, `/model`, `/stop`
- Telegram image and file attachments
- Image attachments passed to Codex via `--image`
- Non-image files downloaded locally and exposed to Codex as readable paths
- Media-group buffering so one album / multi-file send becomes one Codex request
- Structured logs with file/line + chat/session correlation

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
- `.telegram-bridge.lock`
- `logs/bridge.log`
- `logs/error.log`
