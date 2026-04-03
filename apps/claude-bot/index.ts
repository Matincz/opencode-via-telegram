import TelegramBot from "node-telegram-bot-api"
import { config } from "dotenv"
import { createHash } from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { answerCallbackQuerySafe, editMessageTextSafe } from "@matincz/telegram-bot-core/telegram/callback"
import { buildSessionErrorNotice, createDraftSender, escapeHtml, sendRenderedAssistantPart } from "@matincz/telegram-bot-core/telegram/rendering"
import { runClaudePrompt, type ClaudePermissionMode, type ClaudeProcessHandle, type ClaudeStreamEvent } from "./src/claude/client"
import { CLAUDE_MODELS, EFFORT_LEVELS, getDefaultClaudeModel, isClaudeModelId } from "./src/claude/models"
import { installGlobalLogger, logError, logInfo } from "./src/runtime/logger"
import { acquireSingleInstanceLock, SingleInstanceLockError } from "./src/runtime/single-instance"
import {
  chatPermissionModeMap,
  chatWorkingDirectoryMap,
  chatWorkspaceHistoryMap,
  clearChatSession,
  clearChatWorkspaceHistory,
  flushAllPersistence,
  getLatestSessionForWorkspace,
  getSessionRecord,
  listChatSessions,
  loadChatPermissionModes,
  loadChatWorkingDirectories,
  loadChatWorkspaceHistory,
  loadSelectedEfforts,
  loadSelectedModels,
  loadSessionHistory,
  loadSessions,
  rememberChatWorkspace,
  rememberSession,
  saveChatPermissionModes,
  saveChatWorkingDirectories,
  saveSelectedEfforts,
  saveSelectedModels,
  saveSessions,
  selectedEffortMap,
  selectedModelMap,
  sessionMap,
  setChatSession,
} from "./src/store/runtime-state"
import { normalizeWorkspacePath } from "./src/store/workspace-path"
import { normalizeTelegramMessages, parseCommandText, shouldUseMediaGroupBuffer } from "./src/telegram/inbound"
import { deliverClaudeTextResult } from "./src/telegram/delivery"
import { ClaudeDraftState } from "./src/telegram/draft-state"
import { getMediaCacheRoot, resolveTelegramAttachments, scheduleAttachmentCleanup, startMediaCacheJanitor, TelegramMediaError } from "./src/telegram/media"
import { TelegramMediaGroupBuffer } from "./src/telegram/media-group-buffer"
import { buildClaudeEffortPickerMessage, buildClaudeModelPickerMessage } from "./src/telegram/model-picker"
import { ToolStatusTracker } from "./src/telegram/tool-status"
import type { NormalizedInboundMessage, ResolvedTelegramAttachment, TelegramMessageLike } from "./src/telegram/types"

config()

const rootDir = process.cwd()
const logFiles = installGlobalLogger({
  rootDir,
  level: process.env.LOG_LEVEL,
})

console.log(`🪵 日志已初始化 combined=${logFiles.combinedLogPath} error=${logFiles.errorLogPath}`)

const token = process.env.TELEGRAM_BOT_TOKEN
const allowedUserId = process.env.ALLOWED_USER_ID || "ALL"
const claudeBin = process.env.CLAUDE_BIN || "claude"
const claudeCwd = process.env.CLAUDE_CWD || undefined
const defaultModel = String(process.env.CLAUDE_DEFAULT_MODEL || "").trim() || undefined
const defaultEffort = String(process.env.CLAUDE_DEFAULT_EFFORT || "high").trim() || "high"
const permissionMode = (String(process.env.CLAUDE_PERMISSION_MODE || "bypassPermissions").trim() || "bypassPermissions") as ClaudePermissionMode
const maxTurns = Number(process.env.CLAUDE_MAX_TURNS || 0) || undefined
const extraAddDirectories = String(process.env.CLAUDE_ADD_DIRECTORIES || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)

if (!token || !allowedUserId) {
  console.error("❌ 错误：请在 .env 文件中设置 TELEGRAM_BOT_TOKEN 和 ALLOWED_USER_ID。")
  process.exit(1)
}

const telegramToken = token

function getBotLockFiles(telegramToken: string) {
  const tokenFingerprint = createHash("sha256").update(telegramToken).digest("hex").slice(0, 16)
  const globalLockDir = path.join(os.tmpdir(), "matincz-telegram-bot-locks")
  fs.mkdirSync(globalLockDir, { recursive: true })

  return [
    path.join(process.cwd(), ".telegram-bridge.lock"),
    path.join(globalLockDir, `claude-bot-${tokenFingerprint}.lock`),
  ]
}

let releaseSingleInstanceLock = () => {}
let stopTelegramPolling = async () => {}

try {
  const releases = getBotLockFiles(telegramToken).map((lockPath) => acquireSingleInstanceLock(lockPath).release)
  releaseSingleInstanceLock = () => {
    for (const release of releases.slice().reverse()) {
      release()
    }
  }
} catch (error) {
  if (error instanceof SingleInstanceLockError) {
    const pidHint = error.existingPid ? `（PID ${error.existingPid}）` : ""
    console.error(`❌ 检测到另一个 Claude Telegram 实例正在运行${pidHint}：${error.lockPath}`)
    process.exit(1)
  }
  throw error
}

process.on("exit", () => {
  flushAllPersistence()
  void stopTelegramPolling()
  releaseSingleInstanceLock()
})

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    flushAllPersistence()
    void stopTelegramPolling()
    releaseSingleInstanceLock()
    process.exit(0)
  })
}

const bot = new TelegramBot(telegramToken, { polling: false })
const tgApiBase = `https://api.telegram.org/bot${telegramToken}`
const sendDraft = createDraftSender({
  tgApiBase,
  emptyTextBehavior: "zero_width_space",
})

interface ActiveClaudeRun {
  controller: AbortController
  process?: ClaudeProcessHandle
  stopRequested?: boolean
  abortRequested?: boolean
}

const activeResponses = new Map<number, ActiveClaudeRun>()
const typingTimers = new Map<number, ReturnType<typeof setInterval>>()
const lastToolSummaryMap = new Map<number, string>()
const mediaCacheRoot = getMediaCacheRoot(process.env.MEDIA_CACHE_DIR)
const mediaGroupBuffer = new TelegramMediaGroupBuffer<TelegramMessageLike>(350)
let lastInboundAt = Date.now()

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createTelegramUpdatePoller(input: {
  bot: TelegramBot
  tgApiBase: string
  allowedUpdates?: string[]
}) {
  let running = false
  let offset = 0
  let activeController: AbortController | undefined
  let loopPromise: Promise<void> | null = null

  async function pollOnce() {
    activeController = new AbortController()
    const response = await fetch(`${input.tgApiBase}/getUpdates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        offset,
        timeout: 0,
        allowed_updates: input.allowedUpdates,
      }),
      signal: activeController.signal,
    })

    const payload = await response.json().catch(() => undefined) as {
      ok?: boolean
      description?: string
      result?: Array<{ update_id?: number }>
    } | undefined

    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.description || `getUpdates failed with status ${response.status}`)
    }

    const updates = Array.isArray(payload?.result) ? payload.result : []
    for (const update of updates) {
      if (typeof update?.update_id === "number" && update.update_id >= offset) {
        offset = update.update_id + 1
      }

      try {
        input.bot.processUpdate(update as any)
      } catch (error) {
        console.error("处理 Telegram update 失败:", error)
      }
    }
  }

  async function runLoop() {
    while (running) {
      try {
        await pollOnce()
      } catch (error: any) {
        if (!running) break
        if (error?.name === "AbortError") break
        console.error("Telegram polling 失败:", error)
        await sleep(1000)
        continue
      }

      await sleep(1500)
    }
  }

  return {
    start() {
      if (running) return loopPromise ?? Promise.resolve()
      running = true
      loopPromise = runLoop()
      return Promise.resolve()
    },
    async stop() {
      running = false
      activeController?.abort()
      const currentLoop = loopPromise
      if (currentLoop) {
        await currentLoop.catch(() => {})
      }
      loopPromise = null
    },
  }
}

loadSessions()
loadSessionHistory()
loadSelectedModels()
loadSelectedEfforts()
loadChatWorkingDirectories()
loadChatPermissionModes()
loadChatWorkspaceHistory()
startMediaCacheJanitor({ rootDir: mediaCacheRoot })

const CLAUDE_PASSTHROUGH_COMMANDS = [
  { command: "compact", description: "🗜️ 直接调用 Claude /compact" },
  { command: "context", description: "📦 直接调用 Claude /context" },
  { command: "cost", description: "💰 直接调用 Claude /cost" },
  { command: "init", description: "🧱 直接调用 Claude /init" },
  { command: "review", description: "🔎 直接调用 Claude /review" },
  { command: "continue", description: "⏭️ 直接调用 Claude /continue" },
  { command: "debug", description: "🪲 直接调用 Claude /debug" },
] as const

function isAllowedUser(userId?: number) {
  return allowedUserId === "ALL" || String(userId || "") === allowedUserId
}

function stopTyping(chatId: number) {
  const timer = typingTimers.get(chatId)
  if (!timer) return
  clearInterval(timer)
  typingTimers.delete(chatId)
}

function startTyping(chatId: number) {
  stopTyping(chatId)
  void bot.sendChatAction(chatId, "typing").catch(() => {})
  const timer = setInterval(() => {
    void bot.sendChatAction(chatId, "typing").catch(() => {})
  }, 4000)
  typingTimers.set(chatId, timer)
}

function getEffectiveModel(chatId: number) {
  return selectedModelMap.get(chatId) || defaultModel || getDefaultClaudeModel().id
}

function getEffectiveEffort(chatId: number) {
  const selected = selectedEffortMap.get(chatId)
  if (selected && EFFORT_LEVELS.includes(selected as any)) return selected
  return EFFORT_LEVELS.includes(defaultEffort as any) ? defaultEffort : "high"
}

function getEffectivePermissionMode(chatId: number) {
  return chatPermissionModeMap.get(chatId) || permissionMode
}

function getEffectiveCwd(chatId: number) {
  return chatWorkingDirectoryMap.get(chatId) || claudeCwd || process.cwd()
}

function getRequestAddDirectories(chatId: number) {
  return [...new Set(extraAddDirectories.map((entry) => path.resolve(getEffectiveCwd(chatId), entry)))]
}

function getAttachmentCacheRoot(chatId: number) {
  return path.join(getEffectiveCwd(chatId), ".claude-telegram-media")
}

function createDraftId() {
  return Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 100000) + 1
}

function buildMediaCacheKey(normalized: Pick<NormalizedInboundMessage, "chatId" | "mediaGroupId" | "messageIds">) {
  const unique = normalized.mediaGroupId || normalized.messageIds.join("-")
  return `chat-${normalized.chatId}-${unique}`
}

function normalizePermissionMode(raw: string) {
  const value = raw.trim()
  if (["default", "clear", "__default__"].includes(value)) return "__default__" as const
  if (["bypass", "auto", "bypassPermissions"].includes(value)) return "bypassPermissions" as const
  if (["accept", "acceptEdits"].includes(value)) return "acceptEdits" as const
  if (["plan"].includes(value)) return "plan" as const
  if (["default-mode"].includes(value)) return "default" as const
  return null
}

function shortenWorkspacePath(workspace: string) {
  if (workspace.length <= 72) return workspace
  return `...${workspace.slice(-69)}`
}

function buildWelcomeMessage(chatId: number) {
  return [
    "<b>Claude Bot</b>",
    "",
    `当前模型：<code>${getEffectiveModel(chatId)}</code>`,
    `推理力度：<code>${getEffectiveEffort(chatId)}</code>`,
    `权限模式：<code>${getEffectivePermissionMode(chatId)}</code>`,
    `工作目录：<code>${escapeHtml(getEffectiveCwd(chatId))}</code>`,
    "",
    "可用命令：",
    "/model - 切换模型",
    "/models - 打开模型选择器",
    "/effort - 切换推理力度",
    "/mode - 切换权限模式",
    "/cwd - 切换工作目录",
    "/workspaces - 查看历史 workspace",
    "/sessions - 查看会话列表",
    "/resume - 切换到指定会话",
    "/new - 新建会话",
    "/stop - 中止当前请求",
    "/abort - 强制终止当前进程",
    "/status - 查看当前状态",
    "",
    "Claude 透传命令：",
    "/compact /context /cost /init /review /continue /debug",
    "这些命令不会由桥接层处理，会直接发送给 Claude。",
    "",
    "也可以直接发送图片或文件，Bot 会把附件缓存到当前 workspace 供 Claude 读取。",
  ].join("\n")
}

function renderSessions(chatId: number) {
  const currentSessionId = sessionMap.get(chatId)
  const currentWorkspace = getEffectiveCwd(chatId)
  if (currentSessionId && !getSessionRecord(chatId, currentSessionId)) {
    rememberSession(chatId, currentSessionId, { workspace: currentWorkspace })
  }

  const records = listChatSessions(chatId, { workspace: currentWorkspace })
  const lines = [
    "<b>Claude 会话</b>",
    `当前 workspace：<code>${escapeHtml(currentWorkspace)}</code>`,
    `当前会话：<code>${escapeHtml(currentSessionId || "未建立")}</code>`,
    "",
  ]

  if (records.length === 0) {
    lines.push("当前 workspace 还没有保存的会话记录。")
    lines.push("")
    lines.push("用法：<code>/resume &lt;session-id&gt;</code>")
    return lines.join("\n")
  }

  for (const record of records.slice(0, 20)) {
    const currentMark = record.id === currentSessionId ? " [current]" : ""
    lines.push(`• <code>${escapeHtml(record.id)}</code>${currentMark}`)
    lines.push(`  ${escapeHtml(record.label)} · last=${escapeHtml(record.lastUsedAt)}`)
  }

  lines.push("")
  lines.push("用法：<code>/resume &lt;session-id&gt;</code>")
  return lines.join("\n")
}

function buildWorkspaceHistoryMessage(chatId: number) {
  const current = getEffectiveCwd(chatId)
  const history = chatWorkspaceHistoryMap.get(chatId) || []
  const currentSessionId = sessionMap.get(chatId)
  const workspaceSessions = listChatSessions(chatId, { workspace: current })
  const lines = [
    "<b>Workspace 历史</b>",
    `当前：<code>${escapeHtml(current)}</code>`,
    `当前会话：<code>${escapeHtml(currentSessionId || "未建立")}</code>`,
    "",
  ]

  if (history.length === 0) {
    lines.push("当前还没有历史 workspace。")
  } else {
    history.slice(0, 10).forEach((workspace, index) => {
      const mark = workspace === current ? " [current]" : ""
      lines.push(`${index + 1}. <code>${escapeHtml(shortenWorkspacePath(workspace))}</code>${mark}`)
    })
  }

  lines.push("")
  lines.push("<b>该 Workspace 的会话</b>")
  if (workspaceSessions.length === 0) {
    lines.push("当前 workspace 还没有已记录会话。")
  } else {
    workspaceSessions.slice(0, 8).forEach((record, index) => {
      const currentMark = record.id === currentSessionId ? " [current]" : ""
      lines.push(`${index + 1}. <code>${escapeHtml(record.id)}</code>${currentMark}`)
      lines.push(`   ${escapeHtml(record.label)} · last=${escapeHtml(record.lastUsedAt)}`)
    })
  }

  lines.push("")
  lines.push("用法：")
  lines.push("<code>/cwd set /path/to/workspace</code>")
  lines.push("<code>/workspaces clear</code>")

  const inlineKeyboard = [
    ...history.slice(0, 8).map((workspace, index) => [
      { text: `${index + 1}. ${path.basename(workspace) || workspace}`, callback_data: `claude-workspace:${index}` },
    ]),
    ...workspaceSessions.slice(0, 6).map((record) => [
      { text: record.id === currentSessionId ? `✅ ${record.label}` : `▶️ ${record.label}`, callback_data: `claude-session:${record.id}` },
    ]),
    [{ text: "🧹 清空历史", callback_data: "claude-workspace:__clear__" }],
  ]

  return {
    text: lines.join("\n"),
    options: {
      parse_mode: "HTML" as const,
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: inlineKeyboard,
      },
    },
  }
}

function activateWorkspace(chatId: number, workspace: string) {
  const normalizedWorkspace = normalizeWorkspacePath(workspace) || workspace
  chatWorkingDirectoryMap.set(chatId, normalizedWorkspace)
  saveChatWorkingDirectories()
  rememberChatWorkspace(chatId, normalizedWorkspace)

  const nextSession = getLatestSessionForWorkspace(chatId, normalizedWorkspace)
  if (nextSession) {
    setChatSession(chatId, nextSession.id)
    saveSessions()
  } else {
    clearChatSession(chatId)
  }

  return nextSession
}

function activateSession(chatId: number, sessionId: string) {
  const currentWorkspace = getEffectiveCwd(chatId)
  const record = getSessionRecord(chatId, sessionId) || rememberSession(chatId, sessionId, { workspace: currentWorkspace })

  if (record?.workspace && fs.existsSync(record.workspace) && fs.statSync(record.workspace).isDirectory()) {
    chatWorkingDirectoryMap.set(chatId, record.workspace)
    saveChatWorkingDirectories()
    rememberChatWorkspace(chatId, record.workspace)
  }

  setChatSession(chatId, sessionId)
  saveSessions()
  return record
}

async function sendModelPicker(chatId: number, editTarget?: { messageId: number }) {
  const picker = buildClaudeModelPickerMessage({
    currentModel: getEffectiveModel(chatId),
    currentEffort: getEffectiveEffort(chatId),
    defaultModel: defaultModel || getDefaultClaudeModel().id,
  })

  if (editTarget) {
    const edited = await editMessageTextSafe(bot as any, chatId, editTarget.messageId, picker.text, picker.options)
    if (edited) return
  }

  await bot.sendMessage(chatId, picker.text, picker.options).catch(() => {})
}

async function sendEffortPicker(chatId: number, editTarget?: { messageId: number }) {
  const picker = buildClaudeEffortPickerMessage({
    modelId: getEffectiveModel(chatId),
    currentEffort: getEffectiveEffort(chatId),
    fallbackEffort: defaultEffort,
  })

  if (editTarget) {
    const edited = await editMessageTextSafe(bot as any, chatId, editTarget.messageId, picker.text, picker.options)
    if (edited) return
  }

  await bot.sendMessage(chatId, picker.text, picker.options).catch(() => {})
}

function buildPromptWithAttachments(userText: string, attachments: ResolvedTelegramAttachment[], cwd: string) {
  if (attachments.length === 0) return userText

  const lines = [
    "The user attached local files for this request.",
    "Use the paths below directly with your tools when relevant.",
    "",
    ...attachments.map((attachment, index) => {
      const relativePath = path.relative(cwd, attachment.path) || path.basename(attachment.path)
      return `${index + 1}. ${relativePath} (${attachment.mime})`
    }),
    "",
    userText.trim(),
  ]

  return lines.join("\n")
}

async function handlePrompt(chatId: number, userText: string, attachments: ResolvedTelegramAttachment[]) {
  if (activeResponses.has(chatId)) {
    await bot.sendMessage(chatId, "⏳ 当前会话还有一个 Claude 请求在执行，请先发送 /stop 或等待完成。").catch(() => {})
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
    const cwd = getEffectiveCwd(chatId)
    rememberChatWorkspace(chatId, cwd)
    logInfo("TG.CLAUDE.REQUEST", {
      chatId,
      resumeSessionId,
      model: getEffectiveModel(chatId),
      attachmentCount: attachments.length,
    })

    const response = await runClaudePrompt({
      prompt: buildPromptWithAttachments(userText, attachments, cwd),
      model: getEffectiveModel(chatId),
      resume: resumeSessionId,
      cwd,
      claudeBin,
      effort: getEffectiveEffort(chatId),
      permissionMode: getEffectivePermissionMode(chatId),
      addDirectories: getRequestAddDirectories(chatId),
      maxTurns,
      signal: controller.signal,
      onSpawn: (handle) => {
        activeRun.process = handle
      },
      onEvent: (event: ClaudeStreamEvent) => {
        draftState.applyEvent(event)

        if (event.type === "tool_use" && event.toolName) {
          toolTracker.addToolUse(event.toolName)
          lastToolSummaryMap.set(chatId, toolTracker.renderPlain())
          void sendRenderedAssistantPart(bot as any, chatId, "status", toolTracker.renderPlain())
        }

        if (event.type === "tool_progress") {
          toolTracker.addToolProgress(event.toolName, event.summary)
          lastToolSummaryMap.set(chatId, toolTracker.renderPlain())
        }

        if (event.type === "tool_result") {
          toolTracker.markToolResult(event.toolName, "done")
          lastToolSummaryMap.set(chatId, toolTracker.renderPlain())
        }

        if (event.type === "error") {
          toolTracker.markToolResult(undefined, "failed")
          lastToolSummaryMap.set(chatId, toolTracker.renderPlain())
        }

        if (event.type === "task_started" && event.description.trim()) {
          void sendRenderedAssistantPart(bot as any, chatId, "status", `🚀 子任务：${event.description}`)
        }

        if (event.type === "task_progress" && event.summary?.trim()) {
          void sendRenderedAssistantPart(bot as any, chatId, "status", `⏳ 子任务进度：${event.summary}`)
        }

        if (event.type === "task_completed" && event.summary.trim()) {
          void sendRenderedAssistantPart(bot as any, chatId, "status", `✅ 子任务完成：${event.summary}`)
        }

        const nextDraftText = draftState.render()
        const now = Date.now()
        if (!nextDraftText || nextDraftText === lastDraftText || now - lastDraftAt <= 250) {
          return
        }

        lastDraftText = nextDraftText
        lastDraftAt = now
        void sendDraft(chatId, draftId, nextDraftText)
      },
    })

    if (controller.signal.aborted) return

    await sendDraft(chatId, draftId, "").catch(() => {})

    if (response.sessionId) {
      rememberSession(chatId, response.sessionId, { workspace: cwd })
    }

    if (response.sessionId && response.sessionId !== resumeSessionId) {
      setChatSession(chatId, response.sessionId)
      saveSessions()
    }

    const text = response.text || "Claude 已完成，但没有返回可显示的正文。"
    await deliverClaudeTextResult({
      bot,
      chatId,
      text,
      prefix: `claude-chat-${chatId}`,
      caption: "📄 输出较长，已作为文件发送。",
    })
  } catch (error) {
    await sendDraft(chatId, draftId, "").catch(() => {})
    if (activeRun.stopRequested || activeRun.abortRequested || controller.signal.aborted) return

    logError("TG.CLAUDE.REQUEST_FAILED", {
      chatId,
      sessionId: sessionMap.get(chatId),
    }, error)

    await bot.sendMessage(chatId, buildSessionErrorNotice({
      titleHtml: "⚠️ <b>Claude 处理失败</b>",
      rawMessage: error instanceof Error ? error.message : String(error),
    }), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }).catch(() => {})
  } finally {
    activeResponses.delete(chatId)
    stopTyping(chatId)
  }
}

async function handleCommand(msg: TelegramMessageLike, cmd: string, args: string) {
  const chatId = msg.chat.id

  if (cmd === "/start" || cmd === "/help") {
    await bot.sendMessage(chatId, buildWelcomeMessage(chatId), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }).catch(() => {})
    return true
  }

  if (cmd === "/new") {
    clearChatSession(chatId)
    await bot.sendMessage(chatId, "🆕 已清空当前 Claude 会话。下一条消息会新建 session。").catch(() => {})
    return true
  }

  if (cmd === "/sessions") {
    await bot.sendMessage(chatId, renderSessions(chatId), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }).catch(() => {})
    return true
  }

  if (cmd === "/resume") {
    const sessionId = args.trim()
    if (!sessionId) {
      await bot.sendMessage(chatId, "⚠️ 用法：/resume <session-id>").catch(() => {})
      return true
    }
    const record = activateSession(chatId, sessionId)
    await bot.sendMessage(chatId, [
      `▶️ 已切换到会话：<code>${escapeHtml(sessionId)}</code>`,
      `标签：${escapeHtml(record?.label || sessionId)}`,
      `workspace：<code>${escapeHtml(record?.workspace || getEffectiveCwd(chatId))}</code>`,
    ].join("\n"), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }).catch(() => {})
    return true
  }

  if (cmd === "/stop") {
    const activeRun = activeResponses.get(chatId)
    if (!activeRun) {
      await bot.sendMessage(chatId, "当前没有正在执行的 Claude 请求。").catch(() => {})
      return true
    }
    activeRun.stopRequested = true
    activeRun.process?.interrupt()
    await bot.sendMessage(chatId, "🛑 已请求优雅停止当前 Claude 请求。").catch(() => {})
    return true
  }

  if (cmd === "/abort") {
    const activeRun = activeResponses.get(chatId)
    if (!activeRun) {
      await bot.sendMessage(chatId, "当前没有正在执行的 Claude 请求。").catch(() => {})
      return true
    }
    activeRun.abortRequested = true
    activeRun.process?.terminate()
    activeRun.controller.abort()
    activeResponses.delete(chatId)
    stopTyping(chatId)
    await bot.sendMessage(chatId, "🧨 已强制终止当前 Claude 进程。").catch(() => {})
    return true
  }

  if (cmd === "/status") {
    const activeRun = activeResponses.get(chatId)
    const sessionRecord = sessionMap.get(chatId) ? getSessionRecord(chatId, sessionMap.get(chatId)!) : null
    const lines = [
      "<b>Claude Bot 状态</b>",
      `当前模型：<code>${getEffectiveModel(chatId)}</code>`,
      `推理力度：<code>${getEffectiveEffort(chatId)}</code>`,
      `当前会话：<code>${sessionMap.get(chatId) || "未建立"}</code>`,
      `会话标签：<code>${escapeHtml(sessionRecord?.label || "未命名")}</code>`,
      `Claude CLI：<code>${claudeBin}</code>`,
      `工作目录：<code>${escapeHtml(getEffectiveCwd(chatId))}</code>`,
      `权限模式：<code>${getEffectivePermissionMode(chatId)}</code>`,
      `执行状态：<code>${activeResponses.has(chatId) ? "进行中" : "空闲"}</code>`,
      `当前进程：<code>${activeRun?.process?.pid || "无"}</code>`,
      `最近工具：<code>${escapeHtml(lastToolSummaryMap.get(chatId) || "无")}</code>`,
    ]
    await bot.sendMessage(chatId, lines.join("\n"), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }).catch(() => {})
    return true
  }

  if (cmd === "/models") {
    await sendModelPicker(chatId)
    return true
  }

  if (cmd === "/model") {
    const normalizedArgs = args.trim()
    if (!normalizedArgs) {
      await sendModelPicker(chatId)
      return true
    }

    const nextModel = normalizedArgs.startsWith("set ") ? normalizedArgs.slice(4).trim() : normalizedArgs
    if (["clear", "default", "__default__"].includes(nextModel)) {
      selectedModelMap.delete(chatId)
      saveSelectedModels()
      await bot.sendMessage(chatId, `↺ 已恢复使用默认模型：${getEffectiveModel(chatId)}`).catch(() => {})
      await sendEffortPicker(chatId)
      return true
    }

    if (!isClaudeModelId(nextModel)) {
      await bot.sendMessage(chatId, `⚠️ 未知模型：${nextModel}\n可用：${CLAUDE_MODELS.map((model) => model.id).join(", ")}`).catch(() => {})
      return true
    }

    selectedModelMap.set(chatId, nextModel)
    saveSelectedModels()
    await bot.sendMessage(chatId, `✅ 当前聊天模型已切换为：${nextModel}`).catch(() => {})
    await sendEffortPicker(chatId)
    return true
  }

  if (cmd === "/effort") {
    const normalizedArgs = args.trim()
    if (!normalizedArgs) {
      await sendEffortPicker(chatId)
      return true
    }

    if (["clear", "default", "__default__"].includes(normalizedArgs)) {
      selectedEffortMap.delete(chatId)
      saveSelectedEfforts()
      await bot.sendMessage(chatId, `↺ 已恢复使用默认推理力度：${getEffectiveEffort(chatId)}`).catch(() => {})
      return true
    }

    if (!EFFORT_LEVELS.includes(normalizedArgs as any)) {
      await bot.sendMessage(chatId, `⚠️ 不支持的 effort：${normalizedArgs}\n可用：${EFFORT_LEVELS.join(", ")}`).catch(() => {})
      return true
    }

    selectedEffortMap.set(chatId, normalizedArgs)
    saveSelectedEfforts()
    await bot.sendMessage(chatId, `✅ 当前聊天推理力度已切换为：${normalizedArgs}`).catch(() => {})
    return true
  }

  if (cmd === "/mode") {
    const nextMode = normalizePermissionMode(args.trim())
    if (!args.trim()) {
      await bot.sendMessage(chatId, `当前权限模式：<code>${getEffectivePermissionMode(chatId)}</code>\n可用：bypassPermissions / acceptEdits / plan / default`, {
        parse_mode: "HTML",
      }).catch(() => {})
      return true
    }
    if (!nextMode) {
      await bot.sendMessage(chatId, "⚠️ 用法：/mode <bypassPermissions|acceptEdits|plan|default>").catch(() => {})
      return true
    }
    if (nextMode === "__default__" || nextMode === "default") {
      chatPermissionModeMap.delete(chatId)
      saveChatPermissionModes()
      await bot.sendMessage(chatId, `↺ 已恢复默认权限模式：${getEffectivePermissionMode(chatId)}`).catch(() => {})
      return true
    }
    chatPermissionModeMap.set(chatId, nextMode)
    saveChatPermissionModes()
    await bot.sendMessage(chatId, `✅ 当前聊天权限模式已切换为：${nextMode}`).catch(() => {})
    return true
  }

  if (cmd === "/workspaces") {
    const normalizedArgs = args.trim().toLowerCase()
    if (normalizedArgs === "clear") {
      clearChatWorkspaceHistory(chatId)
      await bot.sendMessage(chatId, "🧹 已清空当前聊天的 workspace 历史。").catch(() => {})
      return true
    }
    const message = buildWorkspaceHistoryMessage(chatId)
    await bot.sendMessage(chatId, message.text, message.options).catch(() => {})
    return true
  }

  if (cmd === "/cwd") {
    const normalizedArgs = args.trim()
    if (!normalizedArgs) {
      const message = buildWorkspaceHistoryMessage(chatId)
      await bot.sendMessage(chatId, message.text, message.options).catch(() => {})
      return true
    }

    if (["clear", "default", "__default__"].includes(normalizedArgs)) {
      chatWorkingDirectoryMap.delete(chatId)
      saveChatWorkingDirectories()
      await bot.sendMessage(chatId, `↺ 已恢复默认工作目录：<code>${escapeHtml(getEffectiveCwd(chatId))}</code>`, {
        parse_mode: "HTML",
      }).catch(() => {})
      return true
    }

    const rawPath = normalizedArgs.startsWith("set ") ? normalizedArgs.slice(4).trim() : normalizedArgs
    if (!rawPath) {
      await bot.sendMessage(chatId, "⚠️ 用法：/cwd set <path>").catch(() => {})
      return true
    }

    const resolvedPath = path.resolve(getEffectiveCwd(chatId), rawPath)
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
      await bot.sendMessage(chatId, `⚠️ 目录不存在：${resolvedPath}`).catch(() => {})
      return true
    }

    const normalizedPath = normalizeWorkspacePath(resolvedPath) || resolvedPath
    const activeSession = activateWorkspace(chatId, normalizedPath)
    await bot.sendMessage(chatId, [
      `✅ 当前聊天工作目录已切换为：<code>${escapeHtml(normalizedPath)}</code>`,
      activeSession
        ? `已切换到该 workspace 最近的会话：<code>${escapeHtml(activeSession.id)}</code>`
        : "该 workspace 暂无已记录会话，当前会话已清空。",
    ].join("\n"), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }).catch(() => {})
    return true
  }

  return false
}

bot.on("callback_query", async (query) => {
  if (!isAllowedUser(query.from?.id)) return

  const data = String(query.data || "")
  if (
    !data.startsWith("claude-model:")
    && !data.startsWith("claude-effort:")
    && !data.startsWith("claude-workspace:")
    && !data.startsWith("claude-session:")
  ) {
    return
  }

  const chatId = query.message?.chat.id
  const messageId = query.message?.message_id
  if (!chatId || !messageId) {
    await answerCallbackQuerySafe(bot as any, query.id, "无法定位这条消息。")
    return
  }

  if (data === "claude-model:__picker__") {
    await answerCallbackQuerySafe(bot as any, query.id, "已返回模型列表")
    await sendModelPicker(chatId, { messageId })
    return
  }

  if (data === "claude-effort:__picker__") {
    await answerCallbackQuerySafe(bot as any, query.id, "已打开 effort 选择")
    await sendEffortPicker(chatId, { messageId })
    return
  }

  if (data.startsWith("claude-model:")) {
    const model = data.slice("claude-model:".length)
    if (model === "__default__") {
      selectedModelMap.delete(chatId)
    } else {
      selectedModelMap.set(chatId, model)
    }
    saveSelectedModels()

    const effectiveModel = getEffectiveModel(chatId)
    await answerCallbackQuerySafe(bot as any, query.id, model === "__default__" ? "已恢复默认模型" : `已切换为 ${effectiveModel}`)
    await sendEffortPicker(chatId, { messageId })
    return
  }

  if (data.startsWith("claude-effort:")) {
    const effort = data.slice("claude-effort:".length)
    if (effort === "__default__") {
      selectedEffortMap.delete(chatId)
    } else {
      selectedEffortMap.set(chatId, effort)
    }
    saveSelectedEfforts()

    await answerCallbackQuerySafe(bot as any, query.id, effort === "__default__" ? "已恢复默认推理力度" : `已切换为 ${effort}`)
    await sendEffortPicker(chatId, { messageId })
    return
  }

  if (data.startsWith("claude-workspace:")) {
    const target = data.slice("claude-workspace:".length)
    if (target === "__clear__") {
      clearChatWorkspaceHistory(chatId)
      await answerCallbackQuerySafe(bot as any, query.id, "已清空 workspace 历史")
      const nextMessage = buildWorkspaceHistoryMessage(chatId)
      await editMessageTextSafe(bot as any, chatId, messageId, nextMessage.text, nextMessage.options)
      return
    }

    const index = Number(target)
    const workspace = (chatWorkspaceHistoryMap.get(chatId) || [])[index]
    if (!Number.isInteger(index) || !workspace) {
      await answerCallbackQuerySafe(bot as any, query.id, "这条 workspace 记录已经失效。")
      return
    }

    if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
      await answerCallbackQuerySafe(bot as any, query.id, "目录不存在")
      return
    }

    const activeSession = activateWorkspace(chatId, workspace)
    await answerCallbackQuerySafe(bot as any, query.id, activeSession ? "已切换 workspace 和对应会话" : "已切换 workspace")
    const nextMessage = buildWorkspaceHistoryMessage(chatId)
    await editMessageTextSafe(bot as any, chatId, messageId, nextMessage.text, nextMessage.options)
    return
  }

  const sessionId = data.slice("claude-session:".length)
  const record = getSessionRecord(chatId, sessionId)
  if (!sessionId || !record) {
    await answerCallbackQuerySafe(bot as any, query.id, "这条会话记录已经失效。")
    return
  }

  activateSession(chatId, sessionId)
  await answerCallbackQuerySafe(bot as any, query.id, "已切换到该会话")
  const nextMessage = buildWorkspaceHistoryMessage(chatId)
  await editMessageTextSafe(bot as any, chatId, messageId, nextMessage.text, nextMessage.options)
})

async function processInboundMessages(messages: TelegramMessageLike[]) {
  const normalized = normalizeTelegramMessages(messages)
  if (!normalized) return

  const command = parseCommandText(normalized.bodyText)
  if (command && await handleCommand(messages[0]!, command.cmd, command.args)) {
    return
  }

  let resolvedAttachments: ResolvedTelegramAttachment[] = []
  try {
    resolvedAttachments = await resolveTelegramAttachments({
      token: telegramToken,
      attachments: normalized.attachments,
      cacheRoot: getAttachmentCacheRoot(normalized.chatId),
      cacheKey: buildMediaCacheKey(normalized),
      getFile: (fileId) => bot.getFile(fileId) as any,
    })
  } catch (error) {
    if (error instanceof TelegramMediaError) {
      await bot.sendMessage(normalized.chatId, `⚠️ 附件处理失败：${error.message}`).catch(() => {})
      return
    }
    throw error
  }

  try {
    await handlePrompt(normalized.chatId, normalized.bodyText, resolvedAttachments)
  } finally {
    if (resolvedAttachments.length > 0) {
      scheduleAttachmentCleanup(resolvedAttachments.map((attachment) => attachment.path))
    }
  }
}

bot.on("message", async (msg: TelegramMessageLike) => {
  lastInboundAt = Date.now()
  if (!isAllowedUser(msg.from?.id)) return

  const runProcessor = async (messages: TelegramMessageLike[]) => {
    await processInboundMessages(messages)
  }

  if (shouldUseMediaGroupBuffer(msg) && msg.media_group_id) {
    mediaGroupBuffer.enqueue(`${msg.chat.id}:${msg.media_group_id}`, msg, (messages) => {
      void runProcessor(messages).catch(async (error) => {
        const chatId = messages[0]?.chat.id || msg.chat.id
        await bot.sendMessage(chatId, buildSessionErrorNotice({
          titleHtml: "⚠️ <b>Claude 处理失败</b>",
          rawMessage: error instanceof Error ? error.message : String(error),
        }), {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        }).catch(() => {})
      })
    })
    return
  }

  try {
    await runProcessor([msg])
  } catch (error) {
    await bot.sendMessage(msg.chat.id, buildSessionErrorNotice({
      titleHtml: "⚠️ <b>Claude 处理失败</b>",
      rawMessage: error instanceof Error ? error.message : String(error),
    }), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }).catch(() => {})
  }
})

async function startBot() {
  try {
    const poller = createTelegramUpdatePoller({
      bot,
      tgApiBase,
      allowedUpdates: ["message", "callback_query"],
    })
    stopTelegramPolling = poller.stop
    await poller.start()
    console.log("🤖 Claude Telegram Bot 已启动，等待消息中...")
  } catch (error) {
    console.error("❌ Claude Telegram Bot 启动轮询失败:", error)
    flushAllPersistence()
    releaseSingleInstanceLock()
    process.exit(1)
  }
}

void startBot()
