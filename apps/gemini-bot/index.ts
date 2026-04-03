import TelegramBot from "node-telegram-bot-api"
import { config } from "dotenv"
import * as path from "path"
import { installGlobalLogger, logError, logInfo, logWarn } from "./src/runtime/logger"
import { acquireSingleInstanceLock, SingleInstanceLockError } from "./src/runtime/single-instance"
import { createGeminiTurnRunner, formatGeminiFailureMessage, isGeminiAbortError, preserveGeminiSessionFromError } from "./src/gemini/turn-runner"
import {
  loadPersistedGeminiModel,
  NATIVE_GEMINI_MODEL_OPTIONS,
  savePersistedGeminiModel,
} from "./src/gemini/native-models"
import { bootstrapGeminiCliAuth } from "./src/gemini/auth-bootstrap"
import { applyGeminiCliHome } from "./src/gemini/runtime-paths"
import { listGeminiSessions } from "./src/gemini/sessions"
import {
  hasPendingApproval,
  type ToolApprovalStrategy,
} from "./src/gemini/approval"
import {
  chatHistoryMap,
  clearChatSession,
  flushAllPersistence,
  getChatHistory,
  loadChatHistories,
  loadSelectedModels,
  loadSessions,
  saveChatHistories,
  saveSelectedModels,
  saveSessions,
  sessionMap,
  selectedModelMap,
} from "./src/store/runtime-state"
import {
  loadApprovalRuntimeConfig,
  resolveApprovalRuntimeConfig,
  type GeminiExecutionMode,
} from "./src/store/approval-runtime"
import {
  listCheckpoints,
  listRewindSnapshots,
  loadCheckpoints,
  loadRewindSnapshots,
  pushRewindSnapshot,
  type StoredChatSnapshot,
} from "./src/store/snapshots"
import {
  loadPlanArtifacts,
} from "./src/store/plan-artifacts"
import {
  loadToolApprovalPreferences,
} from "./src/store/tool-approval"
import { buildCheckpointPickerMessage } from "./src/telegram/checkpoint-picker"
import { normalizeTelegramMessages, parseCommandText } from "./src/telegram/inbound"
import {
  getMediaCacheRoot,
  resolveTelegramAttachments,
  scheduleAttachmentCleanup,
  startMediaCacheJanitor,
  TelegramMediaError,
} from "./src/telegram/media"
import { createTelegramPollingWatchdog } from "./src/telegram/polling-watchdog"
import { buildModelPickerMessage } from "./src/telegram/model-picker"
import { buildRewindPickerMessage } from "./src/telegram/rewind-picker"
import { createDraftSender } from "./src/telegram/rendering"
import { buildSessionPickerMessage } from "./src/telegram/session-picker"
import { handleCommand } from "./src/telegram/command-handlers"
import { handleCallbackQuery } from "./src/telegram/callback-handlers"
import type { BotContext } from "./src/telegram/bot-context"
import type { ResolvedTelegramAttachment, TelegramMessageLike } from "./src/telegram/types"

config()

const rootDir = process.cwd()
const geminiCliHome = applyGeminiCliHome(rootDir)
const geminiAuthBootstrap = bootstrapGeminiCliAuth(rootDir)

const logFiles = installGlobalLogger({
  rootDir,
  level: process.env.LOG_LEVEL,
})

console.log(`🪵 日志已初始化 combined=${logFiles.combinedLogPath} error=${logFiles.errorLogPath}`)
if (geminiAuthBootstrap.selectedType) {
  console.log(`🔐 Gemini auth 已从默认 home 继承：${geminiAuthBootstrap.selectedType}`)
}

const token = process.env.TELEGRAM_BOT_TOKEN
const allowedUserId = process.env.ALLOWED_USER_ID || "ALL"
const geminiBin = process.env.GEMINI_BIN || "gemini"
const geminiCwd = process.env.GEMINI_CWD || undefined
const legacyDefaultModel = process.env.GEMINI_DEFAULT_MODEL || undefined
const configuredPlanModel = String(process.env.PLAN_MODEL || process.env.GEMINI_PLAN_MODEL || "").trim() || undefined
const configuredExecutionModel = String(process.env.EXECUTION_MODEL || process.env.GEMINI_EXECUTION_MODEL || "").trim() || undefined
const rawGeminiExecutionMode = String(process.env.GEMINI_EXECUTION_APPROVAL_MODE || process.env.GEMINI_APPROVAL_MODE || "").trim()
const geminiMaxAttempts = Math.max(1, Number(process.env.GEMINI_MAX_ATTEMPTS || 2))
const geminiRetryFetchErrors = !/^(0|false|no)$/i.test(String(process.env.GEMINI_RETRY_FETCH_ERRORS || "true"))
const defaultToolApprovalStrategy: ToolApprovalStrategy = String(process.env.TG_TOOL_APPROVAL_STRATEGY || "notify").trim() as ToolApprovalStrategy
const geminiSandbox = (() => {
  const raw = String(process.env.GEMINI_SANDBOX || "").trim()
  if (!raw || raw === "false" || raw === "0" || raw === "no") return undefined
  if (raw === "true" || raw === "1" || raw === "yes") return true as const
  return raw
})()
const includeDirectories = String(process.env.GEMINI_INCLUDE_DIRECTORIES || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)

if (!token || !allowedUserId) {
  console.error("❌ 错误：请在 .env 文件中设置 TELEGRAM_BOT_TOKEN 和 ALLOWED_USER_ID。")
  process.exit(1)
}

const BOT_LOCK_FILE = path.join(process.cwd(), ".telegram-bridge.lock")
let releaseSingleInstanceLock = () => { }

try {
  const lock = acquireSingleInstanceLock(BOT_LOCK_FILE)
  releaseSingleInstanceLock = lock.release
} catch (error) {
  if (error instanceof SingleInstanceLockError) {
    const pidHint = error.existingPid ? `（PID ${error.existingPid}）` : ""
    console.error(`❌ 检测到另一个 Gemini Telegram 实例正在运行${pidHint}。`)
    process.exit(1)
  }
  throw error
}

process.on("exit", () => {
  flushAllPersistence()
  releaseSingleInstanceLock()
})
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    flushAllPersistence()
    releaseSingleInstanceLock()
    process.exit(0)
  })
}

const bot = new TelegramBot(token, { polling: true })
const tgApiBase = `https://api.telegram.org/bot${token}`
const sendDraft = createDraftSender(tgApiBase)
const activeResponses = new Map<number, AbortController>()
const activeDrafts = new Map<number, number>()
const typingTimers = new Map<number, ReturnType<typeof setInterval>>()
const lastResolvedModelMap = new Map<number, string>()
const lastPlanResolvedModelMap = new Map<number, string>()
const mediaCacheRoot = getMediaCacheRoot(process.env.MEDIA_CACHE_DIR)
let persistedGeminiModel = loadPersistedGeminiModel(process.cwd()) || legacyDefaultModel
let lastInboundAt = Date.now()

function isNativeGeminiSessionId(value: string | undefined) {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
}

function getNativeResumeSession(chatId: number) {
  const sessionId = sessionMap.get(chatId)
  return isNativeGeminiSessionId(sessionId) ? sessionId : undefined
}

function sanitizePersistedSessions() {
  let changed = false
  for (const [chatId, sessionId] of sessionMap.entries()) {
    if (isNativeGeminiSessionId(sessionId)) continue
    sessionMap.delete(chatId)
    changed = true
  }

  if (changed) {
    saveSessions()
  }
}

function getGeminiExecutionMode() {
  if (!rawGeminiExecutionMode) return undefined
  if (rawGeminiExecutionMode === "plan") {
    logWarn("TG.GEMINI.EXECUTION_MODE_UNSUPPORTED", {
      configured: rawGeminiExecutionMode,
      effective: "default",
    }, "Telegram bot 不支持 Gemini CLI 的 plan 审批模式作为执行模式，已回退到 default。")
    return undefined
  }
  return rawGeminiExecutionMode
}

loadSessions()
loadChatHistories()
loadSelectedModels()
loadCheckpoints()
loadPlanArtifacts()
loadRewindSnapshots()
loadToolApprovalPreferences()
loadApprovalRuntimeConfig()
sanitizePersistedSessions()
startMediaCacheJanitor({ rootDir: mediaCacheRoot })
const pollingWatchdog = createTelegramPollingWatchdog({
  bot,
  intervalMs: 15000,
  stalledPendingThresholdMs: 45000,
  getLastInboundAt: () => lastInboundAt,
  getIsBusy: () => activeResponses.size > 0,
  logger: console,
})
pollingWatchdog.start()
const defaultGeminiExecutionMode: GeminiExecutionMode = getGeminiExecutionMode() === "yolo" ? "yolo" : "default"

function refreshPersistedGeminiModel() {
  persistedGeminiModel = loadPersistedGeminiModel(process.cwd()) || legacyDefaultModel
}

function getResolvedApprovalRuntime(chatId: number) {
  return resolveApprovalRuntimeConfig(chatId, {
    strategy: defaultToolApprovalStrategy,
    executionMode: defaultGeminiExecutionMode,
    sandbox: geminiSandbox !== undefined,
  })
}

function getSessionModelOverride(chatId: number) {
  return selectedModelMap.get(chatId)
}

function getExecutionModel(chatId: number) {
  return getSessionModelOverride(chatId) || configuredExecutionModel || persistedGeminiModel
}

function getPlanModel(chatId: number) {
  return configuredPlanModel || getExecutionModel(chatId)
}

function getEffectiveModel(chatId: number) {
  return getExecutionModel(chatId)
}

function getToolApprovalStrategy(chatId: number) {
  return getResolvedApprovalRuntime(chatId).strategy
}

function getModelPicker(chatId: number) {
  return buildModelPickerMessage(NATIVE_GEMINI_MODEL_OPTIONS, getEffectiveModel(chatId) || "Gemini CLI 默认", persistedGeminiModel)
}

async function sendModelPicker(chatId: number) {
  const picker = getModelPicker(chatId)
  await bot.sendMessage(chatId, picker.text, picker.options).catch(() => { })
}

async function sendSessionPicker(chatId: number) {
  const sessions = await listGeminiSessions({ geminiBin, cwd: geminiCwd || process.cwd() })
  if (sessions.length === 0) {
    await bot.sendMessage(chatId, "📭 当前项目还没有 Gemini 原生会话。").catch(() => { })
    return
  }

  const picker = buildSessionPickerMessage(sessions, getNativeResumeSession(chatId))
  await bot.sendMessage(chatId, picker.text, picker.options).catch(() => { })
}

async function switchModel(chatId: number, model: string, persist = false) {
  if (!model.trim()) {
    await bot.sendMessage(chatId, "⚠️ 模型名不能为空。").catch(() => { })
    return false
  }

  if (persist) {
    savePersistedGeminiModel(model, process.cwd())
    selectedModelMap.delete(chatId)
    saveSelectedModels()
    refreshPersistedGeminiModel()
  } else {
    selectedModelMap.set(chatId, model)
    saveSelectedModels()
  }

  logInfo("TG.MODEL.SWITCH", { chatId, model, persist })
  return true
}

async function clearSessionModelOverride(chatId: number) {
  selectedModelMap.delete(chatId)
  saveSelectedModels()
  logInfo("TG.MODEL.SWITCH_RESET", { chatId, model: persistedGeminiModel || "Gemini CLI 默认" })
}

function restoreStoredSnapshot(chatId: number, snapshot: StoredChatSnapshot) {
  clearChatSession(chatId)
  chatHistoryMap.set(chatId, snapshot.history.slice())
  saveChatHistories()
  lastResolvedModelMap.delete(chatId)

  if (snapshot.model) {
    selectedModelMap.set(chatId, snapshot.model)
  } else {
    selectedModelMap.delete(chatId)
  }
  saveSelectedModels()
}

async function sendCheckpointPicker(chatId: number) {
  const checkpoints = listCheckpoints(chatId)
  if (checkpoints.length === 0) {
    await bot.sendMessage(chatId, "📭 当前聊天还没有保存的 checkpoint。").catch(() => { })
    return
  }

  const picker = buildCheckpointPickerMessage(checkpoints)
  await bot.sendMessage(chatId, picker.text, picker.options).catch(() => { })
}

async function sendRewindPicker(chatId: number) {
  let snapshots = listRewindSnapshots(chatId)
  if (snapshots.length === 0 && getChatHistory(chatId).length > 0) {
    pushRewindSnapshot(chatId, {
      title: "当前会话",
      history: getChatHistory(chatId),
      model: getEffectiveModel(chatId) || null,
    })
    snapshots = listRewindSnapshots(chatId)
  }

  if (snapshots.length === 0) {
    await bot.sendMessage(chatId, "📭 当前聊天还没有可用的 rewind 快照。").catch(() => { })
    return
  }

  const picker = buildRewindPickerMessage(snapshots)
  await bot.sendMessage(chatId, picker.text, picker.options).catch(() => { })
}

function startTyping(chatId: number) {
  stopTyping(chatId)
  void bot.sendChatAction(chatId, "typing").catch(() => { })
  const timer = setInterval(() => {
    void bot.sendChatAction(chatId, "typing").catch(() => { })
  }, 4000)
  typingTimers.set(chatId, timer)
}

function stopTyping(chatId: number) {
  const timer = typingTimers.get(chatId)
  if (!timer) return
  clearInterval(timer)
  typingTimers.delete(chatId)
}

function getRequestIncludeDirectories(attachments: ResolvedTelegramAttachment[]) {
  return [...new Set([
    ...includeDirectories,
    ...attachments.map((attachment) => path.dirname(attachment.path)),
  ])]
}

function buildCommonGeminiOptions(chatId: number, attachments: ResolvedTelegramAttachment[], phase: "plan" | "execute" | "direct") {
  const runtime = getResolvedApprovalRuntime(chatId)
  return {
    model: phase === "plan" ? getPlanModel(chatId) : getExecutionModel(chatId),
    geminiBin,
    cwd: geminiCwd,
    maxAttempts: geminiMaxAttempts,
    retryOnFetchErrors: geminiRetryFetchErrors,
    sandbox: phase === "execute"
      ? (runtime.sandbox ? (typeof geminiSandbox === "string" ? geminiSandbox : true) : false)
      : false,
    includeDirectories: getRequestIncludeDirectories(attachments),
  }
}

function clearActiveDraft(chatId: number) {
  const draftId = activeDrafts.get(chatId)
  if (!draftId) return
  activeDrafts.delete(chatId)
  void sendDraft(chatId, draftId, "").catch(() => { })
}

const turnRunner = createGeminiTurnRunner({
  bot,
  sendDraft,
  activeResponses,
  activeDrafts,
  startTyping,
  stopTyping,
  clearActiveDraft,
  getNativeResumeSession,
  getEffectiveModel,
  getExecutionModel,
  getPlanModel,
  getToolApprovalStrategy,
  getResolvedApprovalRuntime,
  buildCommonGeminiOptions,
  getRequestIncludeDirectories,
  setLastResolvedModel: (chatId, model) => {
    lastResolvedModelMap.set(chatId, model)
  },
  setLastPlanResolvedModel: (chatId, model) => {
    lastPlanResolvedModelMap.set(chatId, model)
  },
})

const ctx: BotContext = {
  bot,
  allowedUserId,
  geminiBin,
  geminiCwd,
  geminiSandbox,
  geminiCliHome,
  rootDir,
  mediaCacheRoot,
  token,
  activeResponses,
  turnRunner,
  getEffectiveModel,
  getExecutionModel,
  getPlanModel,
  getToolApprovalStrategy,
  getResolvedApprovalRuntime,
  getModelPicker,
  getSessionModelOverride,
  getNativeResumeSession,
  sendModelPicker,
  sendSessionPicker,
  sendCheckpointPicker,
  sendRewindPicker,
  switchModel,
  clearSessionModelOverride,
  restoreStoredSnapshot,
  stopTyping,
  clearActiveDraft,
  persistedGeminiModel,
  geminiRetryFetchErrors,
  geminiMaxAttempts,
  lastResolvedModelMap,
  lastPlanResolvedModelMap,
}

console.log("🚀 Gemini CLI Telegram Bridge 运行中...")
console.log(`📋 工具审批策略：${defaultToolApprovalStrategy}`)
console.log(`🏠 GEMINI_CLI_HOME：${geminiCliHome}`)
if (geminiCwd) console.log(`📂 Gemini 工作目录：${geminiCwd}`)
if (geminiSandbox) console.log(`🔒 沙箱模式：${geminiSandbox === true ? "on" : geminiSandbox}`)

bot.setMyCommands([
  { command: "new", description: "♻️ 重置当前 Gemini 会话" },
  { command: "status", description: "📊 查看当前状态" },
  { command: "stop", description: "⛔ 中止当前 Gemini 响应" },
  { command: "approval", description: "📋 查看工具审批策略" },
  { command: "plan_mode", description: "🪄 开关计划模式" },
  { command: "sandbox_mode", description: "🧱 开关沙箱模式" },
  { command: "plan", description: "🧭 查看最近计划与进度" },
  { command: "tools", description: "🛠 查看 tools 可见性" },
  { command: "mcp", description: "🔌 查看 MCP 与 trust 状态" },
  { command: "sessions", description: "🗂 查看 Gemini 原生会话列表" },
  { command: "checkpoints", description: "📌 查看 Telegram checkpoints" },
  { command: "rewind", description: "⏪ 恢复到早前快照" },
  { command: "resume", description: "⏮ 恢复 Gemini 原生会话，例如 /resume latest" },
  { command: "delete_session", description: "🗑 删除 Gemini 原生会话，例如 /delete_session 3" },
  { command: "models", description: "🤖 查看可用模型" },
  { command: "model", description: "🛠 设置当前模型，例如 /model gemini-2.5-pro" },
])

bot.on("message", async (rawMsg: any) => {
  const msg = rawMsg as TelegramMessageLike
  const normalized = normalizeTelegramMessages([msg])
  if (!normalized) return

  const chatId = normalized.chatId
  const userId = normalized.fromUserId
  const bodyText = normalized.bodyText
  const command = parseCommandText(bodyText)
  lastInboundAt = Date.now()

  logInfo("TG.MESSAGE.IN", {
    chatId,
    userId,
    messageId: normalized.messageId,
    hasAttachments: normalized.attachments.length > 0,
  }, bodyText)

  if (allowedUserId !== "ALL" && String(userId) !== allowedUserId) {
    await bot.sendMessage(chatId, "🚫 未授权访客。").catch(() => { })
    return
  }

  if (command && await handleCommand(ctx, chatId, command)) {
    return
  }
  const existingController = activeResponses.get(chatId)
  if (existingController) {
    existingController.abort()
    activeResponses.delete(chatId)
    stopTyping(chatId)
    clearActiveDraft(chatId)
    logInfo("TG.GEMINI.SUPERSEDED", { chatId }, "新消息到达，已中止前一个请求")
  }

  try {
    const resolvedAttachments = await resolveTelegramAttachments({
      token,
      attachments: normalized.attachments,
      cacheRoot: mediaCacheRoot,
      cacheKey: `chat-${chatId}-msg-${normalized.messageIds.join("-")}`,
      getFile: async (fileId) => {
        const file = await bot.getFile(fileId)
        return { file_path: file.file_path }
      },
    })

    try {
      await turnRunner.handlePrompt(chatId, bodyText, resolvedAttachments)
    } finally {
      if (!hasPendingApproval(chatId)) {
        scheduleAttachmentCleanup(resolvedAttachments.map((attachment) => attachment.path))
      }
    }
  } catch (error) {
    if (isGeminiAbortError(error)) {
      return
    }
    activeResponses.delete(chatId)
    stopTyping(chatId)
    clearActiveDraft(chatId)
    preserveGeminiSessionFromError(chatId, error)
    logError("TG.GEMINI.REQUEST_FAILED", {
      chatId,
      model: getEffectiveModel(chatId),
    }, error)
    const message = error instanceof TelegramMediaError
      ? `⚠️ 附件处理失败：${error.message}`
      : formatGeminiFailureMessage(error)
    await bot.sendMessage(chatId, message).catch(() => { })
  }
})

bot.on("polling_error", (error: any) => {
  const message = String(error?.message || error || "unknown polling error")
  if (message.includes("409 Conflict")) {
    console.error("❌ Telegram polling 冲突：同一个 Bot Token 正被另一个实例占用。")
    return
  }

  if (/unknown certificate verification error|EFATAL/i.test(message)) {
    void pollingWatchdog.triggerRestart(`polling_error: ${message}`)
  }

  logWarn("TG.POLLING.ERROR", { message }, message)
})

bot.on("callback_query", async (query: any) => {
  await handleCallbackQuery(ctx, query)
})
