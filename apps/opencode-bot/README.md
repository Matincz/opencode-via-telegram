# OpenCode via Telegram

Use [OpenCode](https://opencode.ai) from Telegram with persistent sessions, project switching, streaming replies, permission approval, and file/image input.

This project is a local bridge:

```text
Telegram <-> Telegram Bot API <-> OpenCode via Telegram <-> OpenCode backend
```

It is designed for a single trusted operator. The bridge runs on your machine, talks to your local OpenCode backend, and exposes that workflow through a Telegram bot you control.

## What it supports

- Streaming assistant output in Telegram
- Temporary reasoning bubbles with auto-delete
- Persistent session mapping across restarts
- Project switching and session switching
- Permission approval with inline buttons
- OpenCode `question` prompts in Telegram
- Image and file input:
  - `photo`
  - `document`
  - `video`
  - `audio`
  - `voice`
  - `animation`
  - static `sticker`
- Model selection from configured providers
- Slash commands for common OpenCode actions
- Single-instance lock to avoid Telegram polling conflicts

## Recommended setup

Recommended: run OpenCode Desktop or `opencode web`, then run this bridge.

Why:

- The bridge can auto-detect the Desktop/Web sidecar backend.
- Project switching is reliable in that mode.
- Scoped SSE events are available, so Telegram streaming works correctly.

Fallback: point the bridge at a standalone `opencode serve` instance with `OPENCODE_SERVER_URL`.

Important:

- Basic chat still works against a raw `opencode serve` backend.
- Project switching may be limited there, depending on how that backend was started and which OpenCode version you use.

## Requirements

- [Bun](https://bun.sh) 1.x
- A local OpenCode installation
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your Telegram numeric user ID from [@userinfobot](https://t.me/userinfobot) or similar

## Quick start

### 1. Clone and install

```bash
git clone <your-repo-url>
cd opencode-via-telegram
bun install
```

### 2. Create the environment file

```bash
cp .env.example .env
```

Edit `.env` and set at least:

```env
TELEGRAM_BOT_TOKEN="123456:your-bot-token"
ALLOWED_USER_ID="123456789"
```

### 3. Start an OpenCode backend

Choose one:

#### Option A: OpenCode Desktop / Web

Open OpenCode Desktop, or run:

```bash
opencode web
```

The bridge will auto-discover the local backend when possible.

#### Option B: Standalone OpenCode server

```bash
opencode serve --port 4096
```

If you use this mode, keep `OPENCODE_SERVER_URL=http://127.0.0.1:4096` in `.env`.

### 4. Start the bridge

```bash
bun run start
```

Then open your bot in Telegram and send `/status`.

If the bridge is connected correctly, `/status` should show the active backend, project, and session state.

## Environment variables

Required:

| Variable | Description |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather |
| `ALLOWED_USER_ID` | Telegram user ID allowed to use the bot. Use `ALL` only for local debugging. |

Optional backend settings:

| Variable | Default | Description |
| --- | --- | --- |
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:4096` | Fallback backend URL when Desktop/Web auto-discovery is unavailable |
| `OPENCODE_SERVER_USERNAME` | `opencode` | Basic auth username for protected fallback servers |
| `OPENCODE_SERVER_PASSWORD` | empty | Basic auth password for protected fallback servers |
| `OPENCODE_BACKEND_CACHE_TTL_MS` | `5000` | Backend auto-discovery cache duration |
| `OPENCODE_DESKTOP_SETTINGS_PATH` | platform default | Override Desktop settings file path for sidecar discovery |

Optional runtime tuning:

| Variable | Default | Description |
| --- | --- | --- |
| `OPENCODE_REQUEST_TIMEOUT_MS` | `8000` | Timeout for OpenCode HTTP requests |
| `OPENCODE_RESPONSE_POLL_INTERVAL_MS` | `1000` | Poll interval for sidecar fallback response tracking |
| `OPENCODE_RESPONSE_POLL_TIMEOUT_MS` | `180000` | Overall response timeout |
| `OPENCODE_RESPONSE_POLL_MESSAGE_LIMIT` | `20` | Assistant message window size during poll fallback |
| `TELEGRAM_POLLING_WATCHDOG_INTERVAL_MS` | `15000` | Health-check interval for Telegram long polling |
| `TELEGRAM_PENDING_UPDATE_STALL_MS` | `30000` | Restart polling if Telegram updates stay queued beyond this duration |
| `LOG_LEVEL` | `info` | Minimum runtime log level (`debug`, `info`, `warn`, `error`) |

## Telegram commands

| Command | Description |
| --- | --- |
| `/new` | Reset the current Telegram-side session binding |
| `/status` | Show backend, model, project, and session info |
| `/stop` | Abort the current response |
| `/plan` | Switch the current session to Plan mode |
| `/build` | Switch the current session to Build mode |
| `/undo` | Undo the last action |
| `/redo` | Redo the last undone action |
| `/share` | Share the current OpenCode session |
| `/unshare` | Remove the current share link |
| `/models` | Select a model/provider |
| `/sessions` | List and switch sessions |
| `/projects` | List and switch projects |
| `/commands` | List and trigger custom OpenCode commands |

Any non-command message is forwarded to OpenCode as a prompt. Attachments are downloaded locally and converted into OpenCode-compatible file parts.

## Runtime files

The bridge creates local runtime state files in the project directory:

- `sessions-map.json`
- `selected-models.json`
- `selected-agents.json`
- `active-projects.json`
- `.telegram-bridge.lock`
- `.cache/telegram-media/...`
- `logs/bridge.log`
- `logs/error.log`

These are local runtime artifacts and should not be committed.

## Logging

The bridge writes structured logs with timestamps, levels, and caller locations:

- `logs/bridge.log` for all logs
- `logs/error.log` for warnings and errors only

Unhandled exceptions and rejected promises are also persisted with stack traces.
High-value runtime events also include normalized event names plus correlation fields such as `chatId`, `sessionId`, and `messageId`.

## Development

Run the bridge:

```bash
bun run start
```

Run tests:

```bash
bun test
```

Run type checks:

```bash
bun run check
```

## macOS background services

Example `launchd` files are included:

- `com.user.opencode.server.plist.example`
- `com.user.telegram.bridge.plist.example`

Typical flow:

1. Copy the example plist into `~/Library/LaunchAgents/`
2. Replace paths and usernames with your local values
3. Load it with `launchctl`

Example:

```bash
cp com.user.telegram.bridge.plist.example ~/Library/LaunchAgents/com.user.telegram.bridge.plist
launchctl load ~/Library/LaunchAgents/com.user.telegram.bridge.plist
launchctl start com.user.telegram.bridge
```

## Troubleshooting

### Telegram says nothing / no reply arrives

- Make sure the bridge is running.
- Make sure OpenCode is reachable.
- Send `/status` first and confirm the backend is shown.
- If only `/status` works but normal prompts do not, confirm your OpenCode backend is healthy and the selected project is valid.

### `409 Conflict` in logs

Another process is already polling the same Telegram bot token.

Stop duplicate bridge instances, webhooks, or any other polling client using the same bot.

### Project switching appears wrong

Check `/status` and confirm the backend source:

- Best: `desktop-sidecar`
- Acceptable: `desktop-default-url`
- Limited fallback: `env @ http://127.0.0.1:4096`

If you are on the raw fallback server, project scoping may not behave like Desktop/Web sidecar mode.

### Attachments fail

Common causes:

- Telegram download size limit
- unsupported media type
- model-side media capability mismatch
- OpenCode permission or tool errors

Start with a small image or document and verify `/status` before testing bigger files.

## Known limitations

- Multi-question or multi-select `question` flows are shown in Telegram, but complex answering still falls back to the desktop client.
- This bridge is optimized for a single trusted user, not a public multi-user bot.
- The most reliable project-scoped behavior requires a Desktop/Web sidecar backend.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
