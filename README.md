# OpenCode Telegram Bridge

> 通过 Telegram 使用 [OpenCode](https://opencode.ai) — 支持流式输出、思考过程显示、打字机效果。

A lightweight bridge that connects your OpenCode instance to Telegram, letting you chat with any AI model from anywhere.

---

## ✨ Features

- 💬 **Streaming responses** — messages update in real-time as the AI types
- 🤔 **Reasoning display** — thinking process shown in a separate bubble, auto-deleted after 1 minute
- ⌨️ **Typewriter effect** — smooth character-by-character rendering
- 🔒 **User whitelist** — only your Telegram ID can access the bot
- ♻️ **Session persistence** — conversation context survives bridge restarts
- 🛠️ **Tool status** — shows when the AI is executing tools (e.g. `⚙️ 正在执行: bash`)
- 🖥️ **Markdown rendering** — code blocks, bold, italic, links rendered correctly in Telegram

---

## Prerequisites

| Requirement | Install |
|---|---|
| [Bun](https://bun.sh) ≥ 1.0 | `curl -fsSL https://bun.sh/install \| bash` |
| [OpenCode](https://opencode.ai) | see OpenCode docs — must be running locally |
| A Telegram Bot Token | Create via [@BotFather](https://t.me/BotFather) |
| Your Telegram User ID | Get via [@userinfobot](https://t.me/userinfobot) |

---

## Quick Setup

### 1. Clone & install

```bash
git clone https://github.com/YOUR_USERNAME/opencode-telegram-bridge.git
cd opencode-telegram-bridge
bun install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
TELEGRAM_BOT_TOKEN="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"
ALLOWED_USER_ID="123456789"
OPENCODE_SERVER_URL="http://127.0.0.1:4096"
```

- **`TELEGRAM_BOT_TOKEN`** — from [@BotFather](https://t.me/BotFather)
- **`ALLOWED_USER_ID`** — your numeric Telegram user ID (from [@userinfobot](https://t.me/userinfobot))
- **`OPENCODE_SERVER_URL`** — OpenCode's local HTTP server (default port: `4096`)

### 3. Start OpenCode

Make sure OpenCode is running first:

```bash
opencode
```

### 4. Run the bridge

```bash
bun run index.ts
```

Open Telegram, find your bot, and start chatting!

---

## Run as a Background Service (macOS)

To automatically start the bridge at login and keep it running:

```bash
# 1. Copy and edit the example plist
cp com.user.telegram.bridge.plist.example ~/Library/LaunchAgents/com.user.telegram.bridge.plist
```

Open `~/Library/LaunchAgents/com.user.telegram.bridge.plist` and replace all `YOUR_USERNAME` with your actual macOS username, and update `WorkingDirectory` to the full path of this repo.

```bash
# 2. Load the service
launchctl load ~/Library/LaunchAgents/com.user.telegram.bridge.plist
launchctl start com.user.telegram.bridge
```

**Useful commands:**

```bash
# View logs
tail -f /tmp/telegram-bridge.log

# Restart after config changes
launchctl stop com.user.telegram.bridge && launchctl start com.user.telegram.bridge

# Stop permanently
launchctl unload ~/Library/LaunchAgents/com.user.telegram.bridge.plist
```

---

## Bot Commands

| Command | Description |
|---|---|
| (any message) | Chat with the AI |
| `/new` | Reset conversation context |
| `/status` | Show current session info |

---

## Project Structure

```
opencode-telegram-bridge/
├── index.ts                          # Main bridge code
├── package.json
├── bun.lock
├── .env.example                      # Template for environment variables
├── com.user.telegram.bridge.plist.example  # macOS launchd service template
└── .gitignore
```

---

## How It Works

```
Telegram ←→ Bot API ←→ Bridge (index.ts) ←→ OpenCode HTTP API
                                 ↑
                          SSE event stream
                      (real-time AI output)
```

The bridge:
1. Receives your message from Telegram
2. Forwards it to OpenCode via its REST API
3. Subscribes to OpenCode's SSE `/event` stream for real-time output
4. Edits the Telegram message progressively as the AI responds

---

## Troubleshooting

**Bot doesn't respond**
- Check that OpenCode is running: `curl http://127.0.0.1:4096/session`
- Verify your bot token and user ID in `.env`
- Check logs: `tail -f /tmp/telegram-bridge.log`

**"409 Conflict" error in logs**
- Only one instance of the bridge should be running at a time
- Stop any duplicate processes: `pkill -f "bun run index.ts"`

**Message not updating**
- Telegram rate-limits edits. The bridge throttles at 20ms automatically.

---

## License

MIT
