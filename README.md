# OpenCode Telegram Bridge

> 通过 Telegram 使用 [OpenCode](https://opencode.ai) — 支持流式输出、思考过程气泡、打字机效果。

---

## 功能特性

- 💬 **流式输出** — AI 打字时消息实时更新
- 🤔 **思考过程显示** — 单独气泡展示，1 分钟后自动删除
- ⌨️ **打字机效果** — 平滑逐字渲染
- 🔒 **用户白名单** — 只有你的 Telegram ID 才能访问 Bot
- ♻️ **会话持久化** — 重启 Bridge 后对话上下文不丢失
- 🛠️ **工具状态展示** — AI 执行工具时显示进度（如 `⚙️ 正在执行: bash`）
- � **Markdown 渲染** — 代码块、粗体、斜体、链接在 Telegram 中正确显示

---

## 前置依赖

| 依赖 | 安装方式 |
|---|---|
| [Bun](https://bun.sh) ≥ 1.0 | `curl -fsSL https://bun.sh/install \| bash` |
| [OpenCode](https://opencode.ai) | 参见 OpenCode 文档，需在本地运行 |
| Telegram Bot Token | 通过 [@BotFather](https://t.me/BotFather) 创建 |
| 你的 Telegram 用户 ID | 通过 [@userinfobot](https://t.me/userinfobot) 获取 |

---

## 快速开始

### 1. 克隆并安装

```bash
git clone https://github.com/YOUR_USERNAME/opencode-telegram-bridge.git
cd opencode-telegram-bridge
bun install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`：

```env
TELEGRAM_BOT_TOKEN="从 @BotFather 获取的 Token"
ALLOWED_USER_ID="你的 Telegram 用户 ID（纯数字）"
OPENCODE_SERVER_URL="http://127.0.0.1:4096"
```

- **`TELEGRAM_BOT_TOKEN`** — 在 [@BotFather](https://t.me/BotFather) 创建 Bot 后获得
- **`ALLOWED_USER_ID`** — 在 [@userinfobot](https://t.me/userinfobot) 发送任意消息即可获取
- **`OPENCODE_SERVER_URL`** — OpenCode 本地 HTTP 服务地址（默认端口 `4096`）

### 3. 启动 OpenCode

确保 OpenCode 已在运行：

```bash
opencode serve --port 4096
```

### 4. 启动 Bridge

```bash
bun run index.ts
```

打开 Telegram，找到你的 Bot，开始对话！

---

## 设为后台服务（macOS）

推荐将 OpenCode 和 Bridge **都**配置为 launchd 服务，开机自动启动。

### 步骤一：OpenCode 后台服务

```bash
# 查看 opencode 的安装路径
which opencode

# 复制示例 plist
cp com.user.opencode.server.plist.example ~/Library/LaunchAgents/com.user.opencode.server.plist
```

打开 `~/Library/LaunchAgents/com.user.opencode.server.plist`，把 `opencode` 二进制路径改为 `which opencode` 输出的实际路径，然后：

```bash
launchctl load ~/Library/LaunchAgents/com.user.opencode.server.plist
launchctl start com.user.opencode.server

# 验证是否正常运行
curl http://127.0.0.1:4096/session
```

### 步骤二：Bridge 后台服务

```bash
cp com.user.telegram.bridge.plist.example ~/Library/LaunchAgents/com.user.telegram.bridge.plist
```

打开该文件，将所有 `YOUR_USERNAME` 替换为你的 macOS 用户名，并将 `WorkingDirectory` 改为本仓库的完整路径，然后：

```bash
launchctl load ~/Library/LaunchAgents/com.user.telegram.bridge.plist
launchctl start com.user.telegram.bridge
```

### 常用命令

```bash
# 查看日志
tail -f /tmp/opencode.log           # OpenCode 日志
tail -f /tmp/telegram-bridge.log    # Bridge 日志

# 重启 Bridge（修改配置后）
launchctl stop com.user.telegram.bridge && launchctl start com.user.telegram.bridge

# 停止所有服务
launchctl unload ~/Library/LaunchAgents/com.user.opencode.server.plist
launchctl unload ~/Library/LaunchAgents/com.user.telegram.bridge.plist
```

---

## Bot 命令

| 命令 | 说明 |
|---|---|
| （任意消息） | 与 AI 对话 |
| `/new` | 重置对话上下文 |
| `/status` | 查看当前会话信息 |

---

## 项目结构

```
opencode-telegram-bridge/
├── index.ts                                    # 核心代码
├── package.json
├── bun.lock
├── .env.example                                # 环境变量配置模板
├── com.user.opencode.server.plist.example      # OpenCode 后台服务配置模板
├── com.user.telegram.bridge.plist.example      # Bridge 后台服务配置模板
└── .gitignore
```

---

## 工作原理

```
Telegram ←→ Bot API ←→ Bridge（index.ts）←→ OpenCode HTTP API
                               ↑
                        SSE 事件流（实时 AI 输出）
```

1. 收到你在 Telegram 发送的消息
2. 通过 REST API 转发给 OpenCode
3. 订阅 OpenCode 的 SSE `/event` 流获取实时输出
4. 实时编辑 Telegram 消息，逐步呈现 AI 回答

---

## 常见问题

**Bot 没有响应**
- 检查 OpenCode 是否在运行：`curl http://127.0.0.1:4096/session`
- 确认 `.env` 中的 Token 和 User ID 正确
- 查看日志：`tail -f /tmp/telegram-bridge.log`

**日志中出现 "409 Conflict"**
- 同一时间只能运行一个 Bridge 实例
- 停止重复进程：`pkill -f "bun run index.ts"`

---

## License

MIT
