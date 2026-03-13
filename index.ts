import TelegramBot from "node-telegram-bot-api"
import { config } from "dotenv"
import * as path from "path"
import { fetchOpencodePath, mergeProjectLists, readDesktopLocalProjects, resolveOpencodeBackend } from "./src/opencode/backend"
import { buildSelectableProviders, loadLocalProviderState } from "./src/opencode/model-catalog"
import { createProjectSessionManager, getProjectDisplayName } from "./src/opencode/project-session"
import { acquireSingleInstanceLock, SingleInstanceLockError } from "./src/runtime/single-instance"
import {
  isOverlyBroadProjectWorktree,
  loadActiveProjects,
  loadSelectedAgents,
  loadSelectedModels,
  loadSessions,
  selectedAgentMap,
  selectedModelMap,
} from "./src/store/runtime-state"
import { shouldUseMediaGroupBuffer } from "./src/telegram/inbound"
import { handleTelegramCallbackQuery } from "./src/telegram/callback-query"
import {
  createTelegramInteractiveRequests,
  type PermissionRequestMap,
  type QuestionActionMap,
} from "./src/telegram/interactive-requests"
import {
  cleanupExpiredMediaCache,
  DEFAULT_MEDIA_CACHE_TTL_MS,
  getMediaCacheRoot,
  resolveTelegramAttachments,
  scheduleAttachmentCleanup,
  startMediaCacheJanitor,
} from "./src/telegram/media"
import { TelegramMediaGroupBuffer } from "./src/telegram/media-group-buffer"
import { createTelegramMessageProcessor } from "./src/telegram/message-processor"
import { escapeHtml } from "./src/telegram/rendering"
import { createTelegramStreaming, formatUserFacingError } from "./src/telegram/streaming"
import type { TelegramMessageLike, NormalizedInboundMessage } from "./src/telegram/types"

config()

const token = process.env.TELEGRAM_BOT_TOKEN
const allowedUserId = process.env.ALLOWED_USER_ID || "ALL"
const OPENCODE_REQUEST_TIMEOUT_MS = Number(process.env.OPENCODE_REQUEST_TIMEOUT_MS || "8000")
const OPENCODE_RESPONSE_POLL_INTERVAL_MS = Number(process.env.OPENCODE_RESPONSE_POLL_INTERVAL_MS || "1000")
const OPENCODE_RESPONSE_POLL_TIMEOUT_MS = Number(process.env.OPENCODE_RESPONSE_POLL_TIMEOUT_MS || "180000")
const OPENCODE_RESPONSE_POLL_MESSAGE_LIMIT = Number(process.env.OPENCODE_RESPONSE_POLL_MESSAGE_LIMIT || "20")

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
    console.error(`❌ 检测到另一个 Telegram Bridge 实例正在运行${pidHint}。请只保留一个 polling 进程后重试。`)
    process.exit(1)
  }
  throw error
}

process.on("exit", () => releaseSingleInstanceLock())
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    releaseSingleInstanceLock()
    process.exit(0)
  })
}

const bot = new TelegramBot(token, { polling: true })
const TG_API = `https://api.telegram.org/bot${token}`

type CallbackPayloadMap = Map<string, { type: string; value: string }>

const callbackPayloadMap: CallbackPayloadMap = new Map()
const permRequestMap: PermissionRequestMap = new Map()
const questionActionMap: QuestionActionMap = new Map()
let callbackTokenCount = 0

function createCallbackToken(type: string, value: string) {
  const callbackToken = `${type}:${(callbackTokenCount++).toString(36)}`
  callbackPayloadMap.set(callbackToken, { type, value })
  return callbackToken
}

let buildProjectScopedHeaders: (input?: { chatId?: number; worktree?: string }) => Promise<HeadersInit> = async () => ({})

async function fetchWithOpencodeTimeout(pathname: string, init: RequestInit) {
  return fetchOpencodePath(pathname, init, { timeoutMs: OPENCODE_REQUEST_TIMEOUT_MS })
}

async function opencodeGet(pathname: string, chatId?: number, scoped = false): Promise<any> {
  const headers = scoped ? await buildProjectScopedHeaders({ chatId }) : {}
  const response = await fetchWithOpencodeTimeout(pathname, { headers })
  if (!response.ok && response.status !== 404) throw new Error(`GET ${pathname} failed: ${response.statusText}`)
  return response.json()
}

async function opencodePost(pathname: string, body?: any, chatId?: number, scoped = false): Promise<any> {
  const scopedHeaders = scoped ? await buildProjectScopedHeaders({ chatId }) : {}
  const response = await fetchWithOpencodeTimeout(pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...scopedHeaders },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok && response.status !== 404) throw new Error(`POST ${pathname} failed: ${response.statusText}`)
  return response.json()
}

async function opencodeDelete(pathname: string, chatId?: number, scoped = false): Promise<any> {
  const headers = scoped ? await buildProjectScopedHeaders({ chatId }) : {}
  const response = await fetchWithOpencodeTimeout(pathname, { method: "DELETE", headers })
  if (!response.ok && response.status !== 404) throw new Error(`DELETE ${pathname} failed: ${response.statusText}`)
  return response.json()
}

async function opencodePatch(pathname: string, body: any, chatId?: number, scoped = false): Promise<any> {
  const scopedHeaders = scoped ? await buildProjectScopedHeaders({ chatId }) : {}
  const response = await fetchWithOpencodeTimeout(pathname, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...scopedHeaders },
    body: JSON.stringify(body),
  })
  if (!response.ok && response.status !== 404) throw new Error(`PATCH ${pathname} failed: ${response.statusText}`)
  return response.json()
}

function getServerProviders(providerData: any): any[] {
  const providers: any[] = Array.isArray(providerData?.providers) ? providerData.providers : []
  return providers.filter((provider: any) => provider?.models && Object.keys(provider.models).length > 0)
}

function getProviderDisplayName(provider: any): string {
  if (provider?.id === "google") return "Gemini (Google)"
  return String(provider?.name || provider?.id || "未知供应商")
}

function parseModelRef(model: string): { providerID: string; modelID: string } | undefined {
  const slashIndex = model.indexOf("/")
  if (slashIndex <= 0 || slashIndex === model.length - 1) return undefined
  return {
    providerID: model.slice(0, slashIndex),
    modelID: model.slice(slashIndex + 1),
  }
}

let streaming!: ReturnType<typeof createTelegramStreaming>

const sessionManagerBase = createProjectSessionManager({
  listProjects,
  resolveOpencodeBackend,
  opencodeGet,
  opencodePost,
  disposeChatState: (chatId) => streaming.disposeChatState(chatId),
})

buildProjectScopedHeaders = sessionManagerBase.buildProjectScopedHeaders

const sessionManager = {
  ...sessionManagerBase,
  getProjectDisplayName,
}

async function listProjects() {
  const backendProjects = await opencodeGet("/project").catch(() => [] as any[])
  const backend = await resolveOpencodeBackend().catch(() => null)

  if (!backend || backend.source === "env") {
    return Array.isArray(backendProjects) ? backendProjects : []
  }

  return mergeProjectLists(
    Array.isArray(backendProjects) ? backendProjects : [],
    readDesktopLocalProjects(),
  )
}

async function getModelMenuContext(chatId: number): Promise<{ providers: any[]; currentModel: string }> {
  const [providerData, cfgData, projectData] = await Promise.all([
    opencodeGet("/config/providers", chatId, true),
    opencodeGet("/config", chatId, true).catch(() => null),
    opencodeGet("/project/current", chatId, true).catch(() => null),
  ])

  const projectDir =
    typeof projectData?.worktree === "string"
      ? projectData.worktree
      : typeof projectData?.path === "string"
        ? projectData.path
        : undefined

  return {
    providers: buildSelectableProviders({
      serverProviders: getServerProviders(providerData),
      state: loadLocalProviderState({ projectDir }),
    }),
    currentModel: selectedModelMap.get(chatId) || cfgData?.model || "",
  }
}

loadSessions()
loadSelectedModels()
loadSelectedAgents()
loadActiveProjects()

const mediaCacheRoot = getMediaCacheRoot(process.cwd())
void cleanupExpiredMediaCache(mediaCacheRoot, DEFAULT_MEDIA_CACHE_TTL_MS)
startMediaCacheJanitor({ rootDir: mediaCacheRoot, ttlMs: DEFAULT_MEDIA_CACHE_TTL_MS })
const mediaGroupBuffer = new TelegramMediaGroupBuffer<TelegramMessageLike>(350)

function resolveSelectedModel(chatId: number) {
  const selectedModel = selectedModelMap.get(chatId)
  return selectedModel ? parseModelRef(selectedModel) : undefined
}

async function resolveEffectiveModelInfo(chatId: number) {
  const [providerData, cfgData] = await Promise.all([
    opencodeGet("/config/providers", chatId, true).catch(() => null),
    opencodeGet("/config", chatId, true).catch(() => null),
  ])

  const effectiveModel = selectedModelMap.get(chatId) || cfgData?.model || ""
  const modelRef = parseModelRef(effectiveModel)
  if (!modelRef) return undefined

  const provider = getServerProviders(providerData).find((item) => item.id === modelRef.providerID)
  return provider?.models?.[modelRef.modelID]
}

function buildMediaCacheKey(normalized: NormalizedInboundMessage) {
  const unique = normalized.mediaGroupId || normalized.messageIds.join("-")
  return `${normalized.chatId}-${unique}`
}

async function resolveInboundAttachments(normalized: NormalizedInboundMessage) {
  if (!normalized.attachments.length) return []
  return resolveTelegramAttachments({
    token,
    attachments: normalized.attachments,
    cacheRoot: mediaCacheRoot,
    cacheKey: buildMediaCacheKey(normalized),
    getFile: async (fileId) => bot.getFile(fileId) as any,
  })
}

let interactiveRequests!: ReturnType<typeof createTelegramInteractiveRequests>

streaming = createTelegramStreaming({
  bot,
  tgApiBase: TG_API,
  opencodeRequestTimeoutMs: OPENCODE_REQUEST_TIMEOUT_MS,
  opencodeResponsePollIntervalMs: OPENCODE_RESPONSE_POLL_INTERVAL_MS,
  opencodeResponsePollTimeoutMs: OPENCODE_RESPONSE_POLL_TIMEOUT_MS,
  opencodeResponsePollMessageLimit: OPENCODE_RESPONSE_POLL_MESSAGE_LIMIT,
  resolveOpencodeBackend,
  fetchWithOpencodeTimeout,
  opencodeGet,
  ensureSession: sessionManager.ensureSession,
  getActiveProjectWorktree: sessionManager.getActiveProjectWorktree,
  buildProjectScopedHeaders,
  isOverlyBroadProjectWorktree,
  resolveInboundAttachments,
  scheduleAttachmentCleanup,
  resolveSelectedAgent: (chatId) => selectedAgentMap.get(chatId),
  resolveSelectedModel,
  resolveEffectiveModelInfo,
  sendPermissionRequestPrompt: (chatId, perm) => interactiveRequests.sendPermissionRequestPrompt(chatId, perm),
  sendQuestionRequestPrompt: (chatId, request) => interactiveRequests.sendQuestionRequestPrompt(chatId, request),
})

interactiveRequests = createTelegramInteractiveRequests({
  bot,
  permRequestMap,
  questionActionMap,
  createCallbackToken,
  buildProjectScopedHeaders,
  fetchWithOpencodeTimeout,
  escapeHtml,
  stopTypingIndicator: streaming.stopTypingIndicator,
})

const processTelegramMessages = createTelegramMessageProcessor({
  bot,
  streaming,
  sessionManager,
  listProjects,
  resolveOpencodeBackend,
  opencodeGet,
  opencodePost,
  opencodeDelete,
  opencodePatch,
  fetchWithOpencodeTimeout,
  createCallbackToken,
  getModelMenuContext,
  getProviderDisplayName,
  replyToQuestion: interactiveRequests.replyToQuestion,
  finalizeQuestionPrompt: interactiveRequests.finalizeQuestionPrompt,
  escapeHtml,
  formatUserFacingError,
})

console.log("🚀 OpenCode Telegram Bridge (Enhanced Streaming) 运行中...")

bot.setMyCommands([
  { command: "new", description: "♻️ 重置当前对话，开启新会话" },
  { command: "status", description: "📊 查看当前状态（模型/模式/会话）" },
  { command: "stop", description: "⛔ 中止当前 AI 响应" },
  { command: "plan", description: "🗺️ 切换到 Plan 模式（只分析不修改）" },
  { command: "build", description: "🔨 切换到 Build 模式（默认开发模式）" },
  { command: "undo", description: "↩️ 撤销上一次操作" },
  { command: "redo", description: "↪️ 重做上次被撤销的操作" },
  { command: "share", description: "🔗 分享当前会话并获取公开链接" },
  { command: "unshare", description: "🔒 取消分享当前会话" },
  { command: "models", description: "🤖 查看并切换 AI 模型" },
  { command: "sessions", description: "💬 查看并切换会话（当前项目）" },
  { command: "projects", description: "📁 查看并切换项目" },
  { command: "commands", description: "📋 查看所有可用的自定义命令" },
])

void streaming.listenEvents()

bot.on("callback_query", async (query: any) => {
  await handleTelegramCallbackQuery(query, {
    bot,
    callbackPayloadMap,
    permRequestMap,
    questionActionMap,
    listProjects,
    buildProjectScopedHeaders: ({ chatId }) => buildProjectScopedHeaders({ chatId }),
    fetchWithOpencodeTimeout,
    replyToQuestion: interactiveRequests.replyToQuestion,
    finalizeQuestionPrompt: interactiveRequests.finalizeQuestionPrompt,
    startTypingIndicator: streaming.startTypingIndicator,
    rejectQuestion: interactiveRequests.rejectQuestion,
    disposeChatState: streaming.disposeChatState,
    opencodeGet,
    opencodePost,
    getProjectDisplayName,
    isOverlyBroadProjectWorktree,
    escapeHtml,
    getModelMenuContext,
    getProviderDisplayName,
    createCallbackToken,
  })
})

bot.on("message", async (rawMsg: any) => {
  const msg = rawMsg as TelegramMessageLike
  const chatId = msg.chat.id
  const userId = msg.from?.id
  console.log(`[TG_IN] chat=${chatId} user=${userId} message=${msg.message_id} text=${JSON.stringify(msg.text ?? msg.caption ?? "")}`)

  if (allowedUserId !== "ALL" && String(userId) !== allowedUserId) {
    await bot.sendMessage(chatId, "🚫 未授权访客。")
    return
  }

  const runProcessor = async (messages: TelegramMessageLike[]) => {
    try {
      await processTelegramMessages(messages)
    } catch (error) {
      console.error(`[TG_ERROR] chat=${chatId} error=`, error)
      streaming.clearResponseTracking(chatId)
      streaming.stopTypingIndicator(chatId)
      await bot.sendMessage(chatId, `⚠️ 错误: ${formatUserFacingError(error)}`).catch((sendErr) => {
        console.error(`[TG_SEND_FAIL] chat=${chatId} sendError=`, sendErr)
      })
    }
  }

  if (shouldUseMediaGroupBuffer(msg) && msg.media_group_id) {
    mediaGroupBuffer.enqueue(`${chatId}:${msg.media_group_id}`, msg, runProcessor)
    return
  }

  await runProcessor([msg])
})

let reportedPollingConflict = false

bot.on("polling_error", (error: any) => {
  const message = String(error?.message || error || "unknown polling error")
  if (message.includes("409 Conflict")) {
    if (!reportedPollingConflict) {
      reportedPollingConflict = true
      console.error("❌ Telegram polling 冲突：同一个 Bot Token 正被另一个实例占用。请停止重复的 Bridge / webhook / 轮询进程。")
    }
    return
  }

  console.log(`Polling Error: ${message}`)
})
