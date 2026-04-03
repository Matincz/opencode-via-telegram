# Agents via Telegram

通过 Telegram 控制多种 AI CLI 工具的本地桥接 monorepo。每个 bot 独立运行，共享同一套核心基础设施。

```
Telegram ←→ Bot API ←→ Bridge (Bun) ←→ AI CLI (本地进程)
```

## 架构总览

```
agents-via-telegram/
├── apps/
│   ├── opencode-bot/       # OpenCode Desktop/Web 桥接
│   ├── gemini-bot/         # Gemini CLI 桥接
│   ├── codex-bot/          # OpenAI Codex CLI 桥接
│   └── claude-bot/         # Claude Code CLI 桥接
└── packages/
    └── telegram-bot-core/  # 所有 bot 共享的核心库
```

### 共享核心 (`@matincz/telegram-bot-core`)

| 模块 | 功能 |
|------|------|
| `runtime/logger` | 结构化日志（时间戳、级别、调用位置、关联字段） |
| `runtime/single-instance` | 文件锁，防止多实例竞争 Telegram 轮询 |
| `storage/json` | JSON 文件持久化 |
| `storage/debounced-writer` | 防抖写入，避免高频 I/O |
| `telegram/rendering` | Markdown → Telegram HTML 转换、消息发送重试、Draft API |
| `telegram/inbound` | 入站消息归一化（文本 + 附件） |
| `telegram/media` | 附件下载与缓存 |
| `telegram/media-group-buffer` | 多媒体组（相册）合并为单次请求 |
| `telegram/callback` | 回调按钮处理 |
| `telegram/polling-watchdog` | 轮询健康监控，卡死自动恢复 |
| `telegram/types` | 共享类型定义 |

## 各 Bot 一览

| Bot | CLI 后端 | 通信方式 | 特色功能 |
|-----|---------|---------|---------|
| **opencode-bot** | [OpenCode](https://opencode.ai) | HTTP API + SSE | 项目/会话切换、权限审批、Plan/Build 模式 |
| **gemini-bot** | [Gemini CLI](https://github.com/google-gemini/gemini-cli) | stdio (spawn) | Plan-then-execute 审批、检查点回退、沙盒模式 |
| **codex-bot** | [Codex CLI](https://github.com/openai/codex) | stdio (spawn) | Cron 定时任务、记忆系统、Agent 委派、reasoning effort |
| **claude-bot** | [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) | stdio NDJSON (spawn) | 权限模式切换、effort 调节、子任务追踪 |

### 共同特性

- 实时流式回复（Draft API + 逐步更新）
- 工具调用状态可视化
- 思考过程临时展示（自动删除）
- 多模型切换（inline keyboard）
- 会话管理（创建 / 恢复 / 列表）
- 工作目录切换
- 图片与文件附件支持
- 单用户安全限制 (`ALLOWED_USER_ID`)
- 单实例锁（防轮询冲突）
- 持久化运行时状态（session、model、cwd 等）
- macOS `launchd` 后台运行支持

## 环境要求

- [Bun](https://bun.sh) ≥ 1.x
- 各 CLI 工具需预先安装并完成认证
  - OpenCode Desktop / `opencode web` / `opencode serve`
  - `gemini` CLI（需 Google API Key）
  - `codex` CLI（需 OpenAI API Key）
  - `claude` CLI（需 `claude auth login` 或 `ANTHROPIC_API_KEY`）
- 每个 bot 需要独立的 Telegram bot token（从 [@BotFather](https://t.me/BotFather) 获取）
- 你的 Telegram 数字 user ID（从 [@userinfobot](https://t.me/userinfobot) 获取）

## 快速开始

### 1. 安装依赖

```bash
cd "agents via telegram"
bun install
```

### 2. 配置环境变量

每个 bot 目录下都有 `.env.example`，复制并填写：

```bash
cp apps/opencode-bot/.env.example apps/opencode-bot/.env
cp apps/gemini-bot/.env.example   apps/gemini-bot/.env
cp apps/codex-bot/.env.example    apps/codex-bot/.env
cp apps/claude-bot/.env.example   apps/claude-bot/.env
```

每个 `.env` 至少需要：

```env
TELEGRAM_BOT_TOKEN="从 BotFather 获取"
ALLOWED_USER_ID="你的 Telegram 数字 ID"
```

### 3. 启动 Bot

```bash
# 启动任意一个（或同时启动多个）
bun --cwd apps/opencode-bot run start
bun --cwd apps/gemini-bot run start
bun --cwd apps/codex-bot run start
bun --cwd apps/claude-bot run start
```

启动后在 Telegram 中向你的 bot 发送 `/status` 验证连接。

## 环境变量参考

### OpenCode Bot

| 变量 | 必填 | 默认值 | 说明 |
|------|:----:|-------|------|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Bot token |
| `ALLOWED_USER_ID` | ✅ | — | 允许使用的 Telegram user ID |
| `OPENCODE_SERVER_URL` | — | `http://127.0.0.1:4096` | 后端 URL（Desktop/Web 可自动发现） |
| `OPENCODE_SERVER_USERNAME` | — | `opencode` | Basic auth 用户名 |
| `OPENCODE_SERVER_PASSWORD` | — | — | Basic auth 密码 |
| `OPENCODE_REQUEST_TIMEOUT_MS` | — | `8000` | HTTP 请求超时 |
| `OPENCODE_RESPONSE_POLL_INTERVAL_MS` | — | `1000` | 轮询间隔 |
| `OPENCODE_RESPONSE_POLL_TIMEOUT_MS` | — | `180000` | 总响应超时 |
| `LOG_LEVEL` | — | `info` | 日志级别 |

### Gemini Bot

| 变量 | 必填 | 默认值 | 说明 |
|------|:----:|-------|------|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Bot token |
| `ALLOWED_USER_ID` | ✅ | — | 允许使用的 Telegram user ID |
| `GEMINI_BIN` | — | `/opt/homebrew/bin/gemini` | Gemini CLI 路径 |
| `GEMINI_DEFAULT_MODEL` | — | `auto-gemini-3` | 默认模型 |
| `GEMINI_ALLOWED_MODELS` | — | — | 可选模型列表（逗号分隔） |
| `PLAN_MODEL` | — | — | Plan 阶段模型 |
| `EXECUTION_MODEL` | — | — | 执行阶段模型 |
| `TG_TOOL_APPROVAL_STRATEGY` | — | `plan_then_execute` | 工具审批策略 |
| `GEMINI_SANDBOX` | — | `false` | 是否启用沙盒模式 |
| `LOG_LEVEL` | — | `info` | 日志级别 |

### Codex Bot

| 变量 | 必填 | 默认值 | 说明 |
|------|:----:|-------|------|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Bot token |
| `ALLOWED_USER_ID` | ✅ | — | 允许使用的 Telegram user ID |
| `CODEX_BIN` | — | `/opt/homebrew/bin/codex` | Codex CLI 路径 |
| `CODEX_DEFAULT_MODEL` | — | `gpt-5.4` | 默认模型 |
| `CODEX_REASONING_EFFORT` | — | `high` | 推理力度 |
| `CODEX_PERMISSION_MODE` | — | `workspace-write` | 权限模式 |
| `CODEX_CWD` | — | — | 默认工作目录 |
| `CODEX_ADD_DIRECTORIES` | — | — | 附加目录 |
| `MEDIA_CACHE_DIR` | — | — | 媒体缓存目录 |
| `LOG_LEVEL` | — | `info` | 日志级别 |

### Claude Bot

| 变量 | 必填 | 默认值 | 说明 |
|------|:----:|-------|------|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Bot token |
| `ALLOWED_USER_ID` | ✅ | — | 允许使用的 Telegram user ID |
| `CLAUDE_BIN` | — | `claude` | Claude CLI 路径 |
| `CLAUDE_DEFAULT_MODEL` | — | — | 默认模型 |
| `CLAUDE_MODEL_IDS` | — | — | 可选模型 ID 列表（逗号分隔） |
| `CLAUDE_PERMISSION_MODE` | — | `bypassPermissions` | 权限模式 |
| `CLAUDE_CWD` | — | — | 默认工作目录 |
| `CLAUDE_ADD_DIRECTORIES` | — | — | 附加目录 |
| `CLAUDE_MAX_TURNS` | — | — | 最大对话轮次 |
| `ANTHROPIC_BASE_URL` | — | — | 自定义 API 端点 |
| `ANTHROPIC_AUTH_TOKEN` | — | — | API 认证 token |
| `MEDIA_CACHE_DIR` | — | — | 媒体缓存目录 |
| `LOG_LEVEL` | — | `info` | 日志级别 |

## Telegram 命令参考

### 通用命令（所有 bot）

| 命令 | 说明 |
|------|------|
| `/new` | 重置当前会话 |
| `/status` | 查看当前状态（模型、会话、工作目录等） |
| `/stop` | 中止当前 AI 响应 |
| `/models` | 打开模型选择器（inline keyboard） |
| `/model <name>` | 直接设置模型 |

### OpenCode Bot 专有

| 命令 | 说明 |
|------|------|
| `/plan` | 切换到 Plan 模式 |
| `/build` | 切换到 Build 模式 |
| `/undo` / `/redo` | 撤销/重做 |
| `/share` / `/unshare` | 分享/取消分享会话 |
| `/sessions` | 列出并切换会话 |
| `/projects` | 列出并切换项目 |
| `/commands` | 列出自定义 OpenCode 命令 |

### Gemini Bot 专有

| 命令 | 说明 |
|------|------|
| `/sessions` | 查看会话列表 |
| `/checkpoint` | 检查点回退 |
| `/rewind` | 回滚到指定点 |
| `/sandbox` | 切换沙盒模式 |
| `/planmode` | 切换 Plan/Execute 模式 |

### Codex Bot 专有

| 命令 | 说明 |
|------|------|
| `/effort <level>` | 设置推理力度 |
| `/cwd <path>` | 设置工作目录 |
| `/workspaces` | 查看历史工作区 |
| `/resume <id>` | 恢复指定会话 |
| `/sessions` | 查看会话列表 |
| `/cron` | 管理定时任务 |

### Claude Bot 专有

| 命令 | 说明 |
|------|------|
| `/effort <level>` | 设置推理力度 (low/medium/high/max) |
| `/mode <mode>` | 设置权限模式 |
| `/cwd <path>` | 设置工作目录 |
| `/workspaces` | 查看历史工作区 |
| `/resume <id>` | 恢复指定会话 |
| `/sessions` | 查看会话列表 |
| `/abort` | 强制终止 Claude 进程 |

## 验证与测试

```bash
# 类型检查
bun run check:opencode
bun run check:gemini
bun run check:codex
bun run check:claude

# 单元测试
bun run test:opencode
bun run test:gemini
bun run test:codex
bun run test:claude
```

## macOS 后台运行

项目提供 `launchd` plist 示例文件，可将 bot 注册为 macOS 后台服务：

```bash
# 以 opencode-bot 为例
cp apps/opencode-bot/com.user.telegram.bridge.plist.example \
   ~/Library/LaunchAgents/com.user.telegram.bridge.plist

# 编辑 plist，替换路径和用户名
# 然后加载服务
launchctl load ~/Library/LaunchAgents/com.user.telegram.bridge.plist
launchctl start com.user.telegram.bridge
```

## 运行时文件

每个 bot 会在各自目录下生成运行时文件（不应提交到 git）：

| 文件 | 用途 |
|------|------|
| `sessions-map.json` | chatId → sessionId 映射 |
| `selected-models.json` | 各 chat 当前选择的模型 |
| `.telegram-bridge.lock` | 单实例锁文件 |
| `logs/bridge.log` | 全部日志 |
| `logs/error.log` | 仅 warn/error 日志 |
| `.cache/telegram-media/` | 下载的附件缓存 |

## 日志

所有 bot 使用统一的结构化日志格式：

- 时间戳 + 日志级别 + 调用位置
- 关联字段：`chatId`、`sessionId`、`messageId`
- 未捕获异常与 Promise rejection 自动持久化
- 日志级别通过 `LOG_LEVEL` 控制 (`debug` / `info` / `warn` / `error`)

## 故障排查

| 问题 | 排查方法 |
|------|---------|
| 无回复 | 确认 bot 在运行、CLI 后端可达，发 `/status` 检查 |
| `409 Conflict` | 有其他进程/webhook 在轮询同一 bot token |
| 附件失败 | 检查 Telegram 文件大小限制，先用小文件测试 |
| Session 恢复失败 | 确认 cwd 未变更（CLI 的 session 通常与工作目录绑定） |
| Draft 不更新 | 确认使用的是自定义 Bot API Server（Draft 为非官方 API） |

## 设计原则

- **单用户信任模型**：每个 bot 专为一个可信操作者设计，不是公共多用户服务
- **本地运行**：所有 CLI 在本机执行，不经过远程服务器
- **最小依赖**：核心只依赖 `node-telegram-bot-api` + `dotenv`，无重型框架
- **独立部署**：每个 bot 可独立启动/停止，互不影响
- **渐进降级**：HTML 渲染失败回退纯文本，Draft 失败不阻塞主流程

## License

MIT
