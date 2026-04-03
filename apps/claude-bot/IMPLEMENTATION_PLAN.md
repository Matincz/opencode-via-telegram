# Claude Code Telegram Bot — 实施计划

> 本文件是一份 **可直接执行** 的开发指南。Agent 按步骤实现即可。
> 参考实现：`apps/codex-bot`（同一 monorepo 内，结构几乎 1:1 复制后修改）。

---

## 0. 前置了解

### 0.1 项目结构

```
agents via telegram/
├── apps/
│   ├── codex-bot/          ← 参考实现（Codex CLI → Telegram）
│   ├── claude-bot/         ← 要实现的目标（Claude Code CLI → Telegram）★
│   ├── gemini-bot/
│   └── opencode-bot/
└── packages/
    └── telegram-bot-core/  ← 共享库（rendering / inbound / media / polling-watchdog 等）
```

### 0.2 核心原理

通过 `spawn` 调用 `claude` CLI 的 **headless 模式**：

```bash
claude -p \
  --output-format stream-json \
  --dangerously-skip-permissions \
  --model sonnet \
  --resume <session-id> \
  -- "用户的消息"
```

- `-p` / `--print`：跳过 Ink TUI，进入无头模式
- `--output-format stream-json`：以 NDJSON 实时输出所有事件
- `--dangerously-skip-permissions`：跳过所有权限确认（或用 `--permission-mode bypassPermissions`）
- stdout 输出 NDJSON，每行一个 JSON 对象，schema 定义在 Claude Code SDK 的 `SDKMessageSchema`

### 0.3 Claude Code NDJSON 事件类型（关键）

每行 stdout 是一个 JSON 对象，`type` 字段决定类型。以下是需要处理的事件：

| `type` | `subtype` | 含义 | Telegram 动作 |
|--------|-----------|------|--------------|
| `assistant` | - | 助手文本消息（含 `message.content[]`） | 更新 draft → 最终发送文本 |
| `user` | - | 用户消息回显（仅 `--replay-user-messages`） | 忽略 |
| `result` | `success` | 最终结果（含 `result` 文本） | 发送最终回复 |
| `result` | `error_during_execution` | 执行错误 | 发送错误通知 |
| `result` | `error_max_turns` | 超过最大轮次 | 发送限制通知 |
| `system` | `session_state_changed` | 会话状态变化 | 忽略（内部） |
| `system` | `task_started` | 子代理任务开始 | 显示 status |
| `system` | `task_notification` | 子代理任务完成 | 更新 status |
| `system` | `task_progress` | 子代理进度 | 更新 status |
| `tool_use` | - | 工具调用开始 | 显示工具状态 |
| `tool_result` | - | 工具返回结果 | 更新工具状态 |
| `tool_progress` | - | 工具执行进度 | 更新进度 |
| `partial_assistant` | - | 流式部分消息 | 更新 draft |

---

## 1. 文件结构

在 `apps/claude-bot/` 下创建以下文件：

```
apps/claude-bot/
├── index.ts                          # 入口（仿 codex-bot/index.ts）
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
└── src/
    ├── claude/
    │   ├── client.ts                 # ★ 核心：spawn claude CLI + NDJSON 解析
    │   └── models.ts                 # 模型列表 & 别名
    ├── store/
    │   └── runtime-state.ts          # 持久化状态（session/model/cwd 等）
    ├── telegram/
    │   ├── inbound.ts                # 消息归一化（复用 telegram-bot-core）
    │   ├── draft-state.ts            # 实时 draft 渲染状态机
    │   ├── tool-status.ts            # 工具执行状态追踪
    │   ├── delivery.ts               # 最终结果投递（短文本 / 长文件）
    │   ├── media.ts                  # 附件下载 & 缓存（复用 telegram-bot-core）
    │   └── model-picker.ts           # 模型 / effort 选择器 inline keyboard
    └── runtime/
        ├── logger.ts                 # 日志（复用 telegram-bot-core）
        └── single-instance.ts        # 单实例锁（复用 telegram-bot-core）
```

---

## 2. 逐文件实现说明

### 2.1 `package.json`

```json
{
  "name": "claude-via-telegram",
  "version": "0.1.0",
  "description": "Telegram bridge for Claude Code CLI",
  "main": "index.ts",
  "type": "module",
  "scripts": {
    "start": "bun run index.ts",
    "test": "bun test",
    "check": "tsc --noEmit"
  },
  "dependencies": {
    "@matincz/telegram-bot-core": "workspace:*",
    "dotenv": "^17.3.1",
    "node-telegram-bot-api": "^0.67.0"
  },
  "devDependencies": {
    "@types/node-telegram-bot-api": "^0.64.6",
    "bun-types": "^1.1.0",
    "typescript": "^5.9.2"
  }
}
```

### 2.2 `tsconfig.json`

直接复制 `codex-bot/tsconfig.json`，内容完全相同。

### 2.3 `.env.example`

```env
TELEGRAM_BOT_TOKEN="123456:your-bot-token"
ALLOWED_USER_ID="123456789"
CLAUDE_BIN="claude"
CLAUDE_DEFAULT_MODEL=""
CLAUDE_PERMISSION_MODE="bypassPermissions"
CLAUDE_CWD=""
CLAUDE_ADD_DIRECTORIES=""
CLAUDE_MAX_TURNS=""
MEDIA_CACHE_DIR=""
LOG_LEVEL="info"
```

### 2.4 `.gitignore`

直接复制 `codex-bot/.gitignore`。

---

### 2.5 `src/claude/client.ts` — ★ 核心文件

这是最重要的文件，负责 spawn claude 进程并解析 NDJSON 事件流。

#### 类型定义

```typescript
export type ClaudePermissionMode =
  | "bypassPermissions"
  | "acceptEdits"
  | "default"
  | "plan"

export interface ClaudeRunOptions {
  prompt: string
  model?: string
  resume?: string
  cwd?: string
  claudeBin?: string
  effort?: string               // "low" | "medium" | "high" | "max"
  images?: string[]
  addDirectories?: string[]
  permissionMode?: ClaudePermissionMode
  maxTurns?: number
  timeoutMs?: number
  signal?: AbortSignal
  onEvent?: (event: ClaudeStreamEvent) => void
  onSpawn?: (handle: ClaudeProcessHandle) => void
}

export interface ClaudeProcessHandle {
  pid?: number
  interrupt: () => void
  terminate: () => void
}

export interface ClaudeRunResult {
  sessionId?: string
  text: string
  costUSD?: number
}
```

#### 事件类型

```typescript
interface ClaudeStreamEventBase {
  type: string
  raw: Record<string, unknown>
}

export type ClaudeStreamEvent =
  | { type: "init"; sessionId?: string; raw: Record<string, unknown> }
  | { type: "text_delta"; content: string; raw: Record<string, unknown> }
  | { type: "message"; content: string; raw: Record<string, unknown> }
  | { type: "tool_use"; toolName: string; toolInput?: Record<string, unknown>; raw: Record<string, unknown> }
  | { type: "tool_result"; toolName?: string; raw: Record<string, unknown> }
  | { type: "result"; resultText: string; costUSD?: number; raw: Record<string, unknown> }
  | { type: "error"; message: string; raw: Record<string, unknown> }
  | { type: "task_started"; taskId: string; description: string; raw: Record<string, unknown> }
  | { type: "task_progress"; taskId: string; summary?: string; raw: Record<string, unknown> }
  | { type: "task_completed"; taskId: string; summary: string; raw: Record<string, unknown> }
  | { type: "unknown"; eventType: string; raw: Record<string, unknown> }
```

#### NDJSON 事件解析函数 `parseClaudeStreamEvent`

这是核心解析逻辑。Claude Code 的 `stream-json` 输出格式基于 SDK `SDKMessageSchema`：

```typescript
export function parseClaudeStreamEvent(payload: Record<string, unknown>): ClaudeStreamEvent {
  const type = String(payload.type || "unknown").trim()

  // --- assistant message (完整或部分) ---
  if (type === "assistant" || type === "partial_assistant") {
    // payload.message.content 是一个数组，每个元素是 {type: "text", text: "..."} 或 {type: "tool_use", ...}
    const message = payload.message as Record<string, unknown> | undefined
    const content = Array.isArray(message?.content) ? message!.content : []

    // 提取所有 text 块
    const texts = content
      .filter((block: any) => block?.type === "text" && typeof block.text === "string")
      .map((block: any) => block.text as string)
    const fullText = texts.join("")

    if (type === "partial_assistant" && fullText) {
      return { type: "text_delta", content: fullText, raw: payload }
    }

    if (type === "assistant" && fullText) {
      return { type: "message", content: fullText, raw: payload }
    }

    // 检查是否有 tool_use 块
    const toolUse = content.find((block: any) => block?.type === "tool_use")
    if (toolUse) {
      return {
        type: "tool_use",
        toolName: String(toolUse.name || "unknown"),
        toolInput: toolUse.input as Record<string, unknown>,
        raw: payload,
      }
    }

    return { type: "unknown", eventType: type, raw: payload }
  }

  // --- result ---
  if (type === "result") {
    const subtype = String(payload.subtype || "")
    if (subtype === "success") {
      return {
        type: "result",
        resultText: String(payload.result || ""),
        costUSD: typeof payload.cost_usd === "number" ? payload.cost_usd : undefined,
        raw: payload,
      }
    }
    return {
      type: "error",
      message: subtype === "error_max_turns"
        ? `超过最大轮次限制`
        : String(payload.result || payload.error || "执行出错"),
      raw: payload,
    }
  }

  // --- system events ---
  if (type === "system") {
    const subtype = String(payload.subtype || "")
    if (subtype === "task_started") {
      return {
        type: "task_started",
        taskId: String(payload.task_id || ""),
        description: String(payload.description || ""),
        raw: payload,
      }
    }
    if (subtype === "task_progress") {
      return {
        type: "task_progress",
        taskId: String(payload.task_id || ""),
        summary: typeof payload.summary === "string" ? payload.summary : undefined,
        raw: payload,
      }
    }
    if (subtype === "task_notification") {
      return {
        type: "task_completed",
        taskId: String(payload.task_id || ""),
        summary: String(payload.summary || ""),
        raw: payload,
      }
    }
    // session_state_changed 等内部事件 → 忽略
    return { type: "unknown", eventType: `system:${subtype}`, raw: payload }
  }

  // --- tool_use_summary (工具调用摘要) ---
  if (type === "tool_use_summary") {
    return {
      type: "tool_result",
      toolName: undefined,
      raw: payload,
    }
  }

  return { type: "unknown", eventType: type, raw: payload }
}
```

#### 命令行参数构建函数 `buildClaudeArgs`

```typescript
export function buildClaudeArgs(options: ClaudeRunOptions): string[] {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--no-session-persistence",   // 去掉此行如果需要持久化 session
  ]

  // 权限模式
  if (options.permissionMode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions")
  } else if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode)
  }

  // 模型
  if (options.model) {
    args.push("--model", options.model)
  }

  // effort
  if (options.effort) {
    args.push("--effort", options.effort)
  }

  // resume 会话
  if (options.resume) {
    args.push("--resume", options.resume)
  }

  // 最大轮次
  if (options.maxTurns) {
    args.push("--max-turns", String(options.maxTurns))
  }

  // 额外目录
  for (const dir of options.addDirectories || []) {
    args.push("--add-dir", dir)
  }

  // 图片附件（Claude Code 用 --file 但需要 file_id，用图片路径则需要在 prompt 中用其他方式）
  // 注意：Claude Code 的 --file 参数格式是 file_id:relative_path，需要先上传
  // 简单方案：将图片内容 base64 编码后放入 prompt（不推荐大图）
  // 或者：在 cwd 下放置图片，让 Claude 用 Read 工具读取

  // prompt 放最后
  args.push("--", options.prompt)

  return args
}
```

**注意**：关于 `--no-session-persistence`，建议 **不要** 使用此 flag，因为要支持 `--resume`。
Claude Code 会自动将 session 写入 `~/.claude/sessions/`，通过 stdout 的 `result` 消息的 `session_id` 字段获取 session ID。

实际上 session_id 在 `result` 消息的 `session_id` 字段中返回。也在每条消息的 `session_id` 字段中。

#### 主执行函数 `runClaudePrompt`

与 codex-bot 的 `runCodexPrompt` 结构 **完全一致**，逻辑照搬：

```typescript
export async function runClaudePrompt(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const claudeBin = options.claudeBin || process.env.CLAUDE_BIN || "claude"
  const cwd = options.cwd || process.cwd()
  const timeoutMs = Math.max(1000, options.timeoutMs || Number(process.env.CLAUDE_TIMEOUT_MS || 600000))
  const args = buildClaudeArgs(options)

  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })

    options.onSpawn?.({
      pid: child.pid,
      interrupt: () => child.kill("SIGINT"),
      terminate: () => child.kill("SIGTERM"),
    })

    let stdoutBuffer = ""
    let stderr = ""
    let settled = false
    let sessionId: string | undefined
    let resultText = ""
    let costUSD: number | undefined

    const finish = (handler: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abortHandler)
      handler()
    }

    const abortHandler = () => {
      child.kill("SIGTERM")
      finish(() => reject(new Error("Claude 请求已取消")))
    }

    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      finish(() => reject(new Error(`Claude CLI 请求超时（${timeoutMs}ms）`)))
    }, timeoutMs)

    options.signal?.addEventListener("abort", abortHandler, { once: true })

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk

      while (stdoutBuffer.includes("\n")) {
        const newlineIndex = stdoutBuffer.indexOf("\n")
        const line = stdoutBuffer.slice(0, newlineIndex)
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)

        try {
          const trimmed = line.trim()
          if (!trimmed) continue

          const payload = JSON.parse(trimmed)

          // 提取 session_id（每条消息都可能带）
          if (typeof payload.session_id === "string") {
            sessionId = payload.session_id
          }

          const event = parseClaudeStreamEvent(payload)

          // 累积文本
          if (event.type === "message") {
            resultText = event.content
          }
          if (event.type === "result") {
            resultText = event.resultText || resultText
            costUSD = event.costUSD
          }

          options.onEvent?.(event)
        } catch (error) {
          stderr += `\n[parse-error] ${error instanceof Error ? error.message : String(error)}`
        }
      }
    })

    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => { stderr += chunk })

    child.on("error", (error) => {
      finish(() => reject(new Error(error.message)))
    })

    child.on("close", (code) => {
      finish(() => {
        // 处理 buffer 中剩余数据
        if (stdoutBuffer.trim()) {
          try {
            const payload = JSON.parse(stdoutBuffer.trim())
            if (typeof payload.session_id === "string") sessionId = payload.session_id
            const event = parseClaudeStreamEvent(payload)
            if (event.type === "message") resultText = event.content
            if (event.type === "result") {
              resultText = event.resultText || resultText
              costUSD = event.costUSD
            }
            options.onEvent?.(event)
          } catch {}
        }

        if (code !== 0) {
          const detail = stderr.split("\n").map(l => l.trim()).filter(Boolean).at(-1)
            || resultText || "Claude CLI 未返回更多错误信息。"
          reject(new Error(detail))
          return
        }

        resolve({
          sessionId,
          text: resultText.trim(),
          costUSD,
        })
      })
    })
  })
}
```

---

### 2.6 `src/claude/models.ts`

Claude Code 不像 Codex 有 model discovery endpoint。定义静态模型列表：

```typescript
export interface ClaudeModelInfo {
  id: string
  label: string
  isDefault?: boolean
}

export const CLAUDE_MODELS: ClaudeModelInfo[] = [
  { id: "sonnet", label: "Claude Sonnet (latest)", isDefault: true },
  { id: "opus", label: "Claude Opus (latest)" },
  { id: "haiku", label: "Claude Haiku (latest)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-opus-4", label: "Claude Opus 4" },
]

export const EFFORT_LEVELS = ["low", "medium", "high", "max"] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]
```

---

### 2.7 `src/telegram/draft-state.ts`

与 codex-bot 的 `CodexDraftState` 相同模式，但适配 Claude Code 事件：

```typescript
import type { ClaudeStreamEvent } from "../claude/client"

export class ClaudeDraftState {
  private text = ""
  private readonly toolNames = new Set<string>()
  private taskDescriptions = new Map<string, string>()

  applyEvent(event: ClaudeStreamEvent) {
    if (event.type === "text_delta" && event.content?.trim()) {
      this.text = event.content.trim()
    }
    if (event.type === "message" && event.content?.trim()) {
      this.text = event.content.trim()
    }
    if (event.type === "tool_use" && event.toolName) {
      this.toolNames.add(event.toolName)
    }
    if (event.type === "task_started") {
      this.taskDescriptions.set(event.taskId, event.description)
    }
    if (event.type === "task_completed") {
      this.taskDescriptions.delete(event.taskId)
    }
  }

  render() {
    if (this.text) return this.text

    const sections: string[] = []
    if (this.toolNames.size > 0) {
      sections.push(`使用工具：${Array.from(this.toolNames).join(", ")}`)
    }
    if (this.taskDescriptions.size > 0) {
      sections.push(`子任务：${Array.from(this.taskDescriptions.values()).join(", ")}`)
    }
    return sections.join("\n\n")
  }
}
```

---

### 2.8 `src/telegram/tool-status.ts`

直接复制 `codex-bot/src/telegram/tool-status.ts`，完全相同。

---

### 2.9 `src/telegram/delivery.ts`

直接复制 `codex-bot/src/telegram/delivery.ts`，仅修改：
- `OUTPUT_TO_USER_DIR` 路径
- 文件名前缀改为 `"claude-output"`

---

### 2.10 `src/telegram/model-picker.ts`

与 codex-bot 类似，但 callback_data 前缀改为 `"claude-model:"` 和 `"claude-effort:"`。
使用 `CLAUDE_MODELS` 和 `EFFORT_LEVELS` 构建 inline keyboard。

---

### 2.11 `src/store/runtime-state.ts`

直接参考 `codex-bot/src/store/runtime-state.ts`，管理以下持久化 Map：
- `sessionMap: Map<number, string>` — chatId → Claude session UUID
- `selectedModelMap: Map<number, string>` — chatId → model
- `selectedEffortMap: Map<number, string>` — chatId → effort
- `chatWorkingDirectoryMap: Map<number, string>` — chatId → cwd
- `chatPermissionModeMap: Map<number, ClaudePermissionMode>`

使用 `@matincz/telegram-bot-core/storage/json` 的 `loadJsonSync` / `saveJsonSync` 持久化到 JSON 文件。

---

### 2.12 `index.ts` — 入口文件

结构 **仿照** `codex-bot/index.ts`，核心流程：

#### 2.12.1 初始化

```typescript
import TelegramBot from "node-telegram-bot-api"
import { config } from "dotenv"
import { createDraftSender, sendRenderedAssistantPart, buildSessionErrorNotice } from "@matincz/telegram-bot-core/telegram/rendering"
import { createTelegramPollingWatchdog } from "@matincz/telegram-bot-core/telegram/polling-watchdog"
import { acquireSingleInstanceLock } from "@matincz/telegram-bot-core/runtime/single-instance"
import { installGlobalLogger } from "@matincz/telegram-bot-core/runtime/logger"
import { normalizeTelegramMessages, parseCommandText } from "./src/telegram/inbound"
import { runClaudePrompt, type ClaudeStreamEvent, type ClaudeProcessHandle } from "./src/claude/client"
import { ClaudeDraftState } from "./src/telegram/draft-state"
import { ToolStatusTracker } from "./src/telegram/tool-status"
import { deliverClaudeTextResult } from "./src/telegram/delivery"
// ... store imports

config()
// ... 读取 env 变量（TELEGRAM_BOT_TOKEN, ALLOWED_USER_ID, CLAUDE_BIN, CLAUDE_CWD, CLAUDE_DEFAULT_MODEL 等）
// ... 单实例锁
// ... new TelegramBot(token, { polling: true })
// ... createDraftSender
// ... loadSessions / loadSelectedModels 等
// ... pollingWatchdog.start()
```

#### 2.12.2 `handlePrompt` 函数

这是最核心的函数，与 codex-bot 的 `handlePrompt` 结构一致：

```typescript
async function handlePrompt(chatId: number, userText: string, attachments: ResolvedTelegramAttachment[]) {
  if (activeResponses.has(chatId)) {
    await bot.sendMessage(chatId, "⏳ 当前还有一个 Claude 请求在执行…").catch(() => {})
    return
  }

  const controller = new AbortController()
  const activeRun: ActiveClaudeRun = { controller }
  activeResponses.set(chatId, activeRun)
  startTyping(chatId)

  const resumeSessionId = sessionMap.get(chatId)
  const toolTracker = new ToolStatusTracker()
  const draftId = createDraftId()
  const draftState = new ClaudeDraftState()
  let lastDraftText = ""
  let lastDraftAt = 0

  try {
    const response = await runClaudePrompt({
      prompt: userText,
      model: getEffectiveModel(chatId),
      resume: resumeSessionId,
      cwd: getEffectiveCwd(chatId),
      claudeBin,
      effort: getEffectiveEffort(chatId),
      permissionMode: getEffectivePermissionMode(chatId),
      images: getImageAttachments(attachments),
      addDirectories: getRequestAddDirectories(),
      maxTurns: maxTurns,
      signal: controller.signal,
      onSpawn: (handle) => { activeRun.process = handle },
      onEvent: (event: ClaudeStreamEvent) => {
        draftState.applyEvent(event)

        // 工具调用状态
        if (event.type === "tool_use") {
          toolTracker.addToolUse(event.toolName)
          void sendRenderedAssistantPart(bot, chatId, "status", toolTracker.renderPlain())
        }

        // 子任务
        if (event.type === "task_started") {
          void sendRenderedAssistantPart(bot, chatId, "status", `🚀 子任务：${event.description}`)
        }

        // 实时 draft 更新
        const nextDraftText = draftState.render()
        const now = Date.now()
        if (!nextDraftText || nextDraftText === lastDraftText || now - lastDraftAt <= 250) return
        lastDraftText = nextDraftText
        lastDraftAt = now
        void sendDraft(chatId, draftId, nextDraftText)
      },
    })

    if (controller.signal.aborted) return
    await sendDraft(chatId, draftId, "").catch(() => {})

    // 记录 session
    if (response.sessionId && response.sessionId !== resumeSessionId) {
      setChatSession(chatId, response.sessionId)
      saveSessions()
    }

    // 投递最终结果
    const text = response.text || "Claude 已完成，但没有返回可显示的正文。"
    await deliverClaudeTextResult({ bot, chatId, text, prefix: `claude-chat-${chatId}` })
  } catch (error) {
    await sendDraft(chatId, draftId, "").catch(() => {})
    if (activeRun.stopRequested || controller.signal.aborted) return
    await bot.sendMessage(chatId, buildSessionErrorNotice({
      titleHtml: "⚠️ <b>Claude 处理失败</b>",
      rawMessage: error instanceof Error ? error.message : String(error),
    }), { parse_mode: "HTML", link_preview_options: { is_disabled: true } }).catch(() => {})
  } finally {
    activeResponses.delete(chatId)
    stopTyping(chatId)
  }
}
```

#### 2.12.3 命令列表

```typescript
bot.setMyCommands([
  { command: "new", description: "♻️ 重置当前 Claude 会话" },
  { command: "sessions", description: "🧵 查看会话列表" },
  { command: "resume", description: "▶️ 切换到指定会话" },
  { command: "status", description: "📊 查看当前状态" },
  { command: "stop", description: "⛔ 中止当前 Claude 响应" },
  { command: "abort", description: "🧨 强制终止当前 Claude 进程" },
  { command: "models", description: "🤖 打开模型选择器" },
  { command: "model", description: "🛠 设置当前模型" },
  { command: "effort", description: "🧠 设置推理力度" },
  { command: "mode", description: "🔐 设置权限模式" },
  { command: "cwd", description: "📁 设置工作目录" },
  { command: "workspaces", description: "🗂 查看历史 workspace" },
  { command: "help", description: "📋 查看可用命令" },
])
```

#### 2.12.4 命令处理

命令处理函数 `handleCommand` 与 codex-bot 一致，支持：

| 命令 | 实现 |
|------|------|
| `/new` | `clearChatSession(chatId)` |
| `/stop` | `activeRun.controller.abort()` + `process.interrupt()` |
| `/abort` | `process.terminate()` |
| `/model <name>` | `selectedModelMap.set(chatId, name)` |
| `/models` | 发送 inline keyboard |
| `/effort <level>` | `selectedEffortMap.set(chatId, level)` |
| `/mode <mode>` | `chatPermissionModeMap.set(chatId, mode)` |
| `/cwd <path>` | `chatWorkingDirectoryMap.set(chatId, path)` |
| `/resume <id>` | `setChatSession(chatId, id)` |
| `/sessions` | 列出当前 workspace 的会话 |
| `/workspaces` | 列出历史 workspace |
| `/status` | 显示当前 model/effort/cwd/session |

#### 2.12.5 消息监听

```typescript
bot.on("message", async (msg) => {
  lastInboundAt = Date.now()
  if (!isAllowedUser(msg.from?.id)) return
  // ... mediaGroupBuffer 处理（与 codex-bot 相同）
  // ... normalizeTelegramMessages → parseCommandText → handleCommand 或 handlePrompt
})

bot.on("callback_query", async (query) => {
  // 处理 claude-model: / claude-effort: 前缀的回调
})
```

---

## 3. 关键差异对照表（Claude Code vs Codex）

| 维度 | Codex (codex-bot) | Claude Code (claude-bot) |
|------|-------------------|--------------------------|
| CLI 二进制 | `codex` | `claude` |
| 模式参数 | `exec --json` | `-p --output-format stream-json` |
| 权限跳过 | `--full-auto` / `--dangerously-bypass-approvals-and-sandbox` | `--dangerously-skip-permissions` / `--permission-mode bypassPermissions` |
| 模型参数 | `--model` | `--model`（支持别名如 sonnet/opus） |
| 会话恢复 | `exec resume -- <id>` | `--resume <id>` |
| effort 参数 | `-c model_reasoning_effort=xxx` | `--effort low\|medium\|high\|max` |
| 额外目录 | `--add-dir` | `--add-dir` |
| 输出格式 | NDJSON（Codex 自有 schema） | NDJSON（SDK `SDKMessageSchema`） |
| session_id | `thread.started` 事件的 `thread_id` | 每条消息的 `session_id` 字段 |
| 文本内容 | `item.completed` + `type=agent_message` | `assistant` 消息的 `message.content[].text` |
| 工具调用 | `item.started` + `type=shell\|file_edit\|...` | `assistant` 消息的 `message.content[]` 中 `type=tool_use` 块 |
| 完成信号 | `turn.completed` | `result` + `subtype=success` |
| 模型发现 | `codex app-server` JSON-RPC | 无（使用静态列表） |

---

## 4. 实现优先级

### Phase 1：核心可用（MVP）
1. `src/claude/client.ts` — spawn + NDJSON 解析
2. `src/store/runtime-state.ts` — session/model/cwd 持久化
3. `src/telegram/draft-state.ts` — draft 渲染
4. `src/telegram/tool-status.ts` — 工具状态
5. `src/telegram/delivery.ts` — 结果投递
6. `index.ts` — 入口，`handlePrompt` + 基本命令（/new /stop /model /cwd）

### Phase 2：完善体验
7. `src/telegram/model-picker.ts` — inline keyboard
8. callback_query 处理
9. /sessions /resume /workspaces 命令
10. 附件处理（图片 → 写入 cwd → Claude 可访问）

### Phase 3：高级功能（可选）
11. 执行审批模式（如 codex-bot 的 approval 机制）
12. Agent 委派
13. Cron 定时任务
14. Memory 系统

---

## 5. 测试验证

### 5.1 手动测试清单

```bash
# 1. 启动 bot
cd apps/claude-bot && bun run start

# 2. Telegram 发送消息
"hello"                    → 应收到 Claude 回复
"/model opus"              → 应切换模型
"/effort high"             → 应切换 effort
"/cwd /tmp"                → 应切换工作目录
"/new"                     → 应清除 session
"/stop"                    → 应中止当前请求
"list files in current dir" → 应看到工具调用状态 + 结果
```

### 5.2 验证 Claude CLI 独立工作

```bash
# 先确认 claude CLI 可用
claude -p --output-format stream-json --dangerously-skip-permissions -- "hello"
# 应看到 NDJSON 输出
```

---

## 6. 注意事项

1. **`claude` 需要已登录认证**：确保运行 bot 的机器上已执行 `claude auth login` 或设置了 `ANTHROPIC_API_KEY`
2. **Session 持久化路径**：Claude Code 将 session 文件保存在 `~/.claude/sessions/` 下，按 cwd 分组
3. **`--resume` 只能恢复同一 cwd 的 session**：切换 cwd 后之前的 session 无法直接 resume
4. **进程清理**：确保 `SIGINT`/`SIGTERM` 时杀掉所有子进程
5. **Telegram 消息限制**：单条消息最长 4096 字符，长回复需要分片或发文件（delivery.ts 已处理）
6. **Draft API**：`sendMessageDraft` 是 Telegram 非官方 API，需要自定义 Bot API Server 支持

---

## 7. 根目录 package.json 更新

在根目录 `package.json` 的 `scripts` 中添加：

```json
{
  "scripts": {
    "check:claude": "bun run --cwd apps/claude-bot check",
    "test:claude": "bun run --cwd apps/claude-bot test"
  }
}
```
