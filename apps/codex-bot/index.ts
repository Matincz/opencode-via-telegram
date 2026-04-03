import TelegramBot from "node-telegram-bot-api"
import { config } from "dotenv"
import * as fs from "fs"
import * as path from "path"
import { answerCallbackQuerySafe, editMessageTextSafe } from "@matincz/telegram-bot-core/telegram/callback"
import { createTelegramPollingWatchdog } from "@matincz/telegram-bot-core/telegram/polling-watchdog"
import { buildSessionErrorNotice, createDraftSender, escapeHtml, sendRenderedAssistantPart } from "@matincz/telegram-bot-core/telegram/rendering"
import { installGlobalLogger, logError, logInfo } from "./src/runtime/logger"
import { acquireSingleInstanceLock, SingleInstanceLockError } from "./src/runtime/single-instance"
import { parseCronOptionArgs, tokenizeCronArgs } from "./src/cron/client"
import { CodexCronManager } from "./src/cron/manager"
import { addCronJob, cronJobMap, flushCronJobs, loadCronJobs, readCronTaskFile, removeCronJob, updateCronJob, writeCronTaskFile } from "./src/cron/store"
import { runCodexPrompt, type CodexPermissionMode, type CodexProcessHandle, type CodexStreamEvent } from "./src/codex/client"
import {
  buildExecutionApprovalMessage,
  clearPendingApproval,
  createApprovalToken,
  getPendingApproval,
  hasPendingApproval,
  setPendingApproval,
  type ExecutionApprovalMode,
} from "./src/codex/approval"
import { buildCodexPrompt } from "./src/codex/prompt"
import { discoverCodexModels, FALLBACK_CODEX_MODELS, type CodexModelInfo } from "./src/codex/discovery"
import {
  addMainMemoryItem,
  editMainMemoryItem,
  ensureMainMemoryFile,
  normalizeMemorySection,
  readMainMemory,
  readMainMemorySections,
  removeMainMemoryItem,
  searchMainMemory,
} from "./src/memory/store"
import {
  flushSessionHistory,
  getLatestSessionForWorkspace,
  getSessionRecord,
  listChatSessions,
  loadSessionHistory,
  rememberSession,
  renameSession,
} from "./src/store/session-history"
import {
  chatWorkspaceHistoryMap,
  chatPermissionModeMap,
  chatWorkingDirectoryMap,
  clearChatSession,
  clearChatWorkspaceHistory,
  executionApprovalModeMap,
  flushAllPersistence,
  loadChatPermissionModes,
  loadChatWorkingDirectories,
  loadChatWorkspaceHistory,
  loadExecutionApprovalModes,
  loadSelectedModels,
  loadSelectedReasoningEfforts,
  loadSessions,
  rememberChatWorkspace,
  saveChatPermissionModes,
  saveChatWorkingDirectories,
  saveExecutionApprovalModes,
  saveSelectedReasoningEfforts,
  saveSelectedModels,
  saveSessions,
  selectedReasoningEffortMap,
  selectedModelMap,
  sessionMap,
  setChatSession,
} from "./src/store/runtime-state"
import { normalizeTelegramMessages, parseCommandText, shouldUseMediaGroupBuffer } from "./src/telegram/inbound"
import {
  getMediaCacheRoot,
  resolveTelegramAttachments,
  scheduleAttachmentCleanup,
  startMediaCacheJanitor,
  TelegramMediaError,
} from "./src/telegram/media"
import { TelegramMediaGroupBuffer } from "./src/telegram/media-group-buffer"
import { buildAttachmentPreviewMessage } from "./src/telegram/attachment-preview"
import { deliverCodexTextResult } from "./src/telegram/delivery"
import { CodexDraftState } from "./src/telegram/draft-state"
import { buildCodexEffortPickerMessage, buildCodexModelPickerMessage } from "./src/telegram/model-picker"
import { ToolStatusTracker } from "./src/telegram/tool-status"
import { flushAgentProfiles, getAgentProfile, listAgentProfiles, loadAgentProfiles, removeAgentProfile, upsertAgentProfile } from "./src/agents/store"
import { normalizeWorkspacePath } from "./src/store/workspace-path"
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
const codexBin = process.env.CODEX_BIN || "codex"
const codexCwd = process.env.CODEX_CWD || undefined
const defaultModel = String(process.env.CODEX_DEFAULT_MODEL || "").trim() || undefined
const reasoningEffort = String(process.env.CODEX_REASONING_EFFORT || "high").trim() || "high"
const permissionMode = (String(process.env.CODEX_PERMISSION_MODE || "workspace-write").trim() || "workspace-write") as CodexPermissionMode
const executionApprovalMode = (String(process.env.CODEX_EXECUTION_APPROVAL_MODE || "prompt").trim() || "prompt") as ExecutionApprovalMode
const extraAddDirectories = String(process.env.CODEX_ADD_DIRECTORIES || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)

if (!token || !allowedUserId) {
  console.error("❌ 错误：请在 .env 文件中设置 TELEGRAM_BOT_TOKEN 和 ALLOWED_USER_ID。")
  process.exit(1)
}

const telegramToken = token

const BOT_LOCK_FILE = path.join(process.cwd(), ".telegram-bridge.lock")
let releaseSingleInstanceLock = () => { }

try {
  const lock = acquireSingleInstanceLock(BOT_LOCK_FILE)
  releaseSingleInstanceLock = lock.release
} catch (error) {
  if (error instanceof SingleInstanceLockError) {
    const pidHint = error.existingPid ? `（PID ${error.existingPid}）` : ""
    console.error(`❌ 检测到另一个 Codex Telegram 实例正在运行${pidHint}。`)
    process.exit(1)
  }
  throw error
}

process.on("exit", () => {
  flushAllPersistence()
  flushSessionHistory()
  flushAgentProfiles()
  flushCronJobs()
  releaseSingleInstanceLock()
})

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    flushAllPersistence()
    flushSessionHistory()
    flushAgentProfiles()
    flushCronJobs()
    releaseSingleInstanceLock()
    process.exit(0)
  })
}

const bot = new TelegramBot(telegramToken, { polling: true })
const sendDraft = createDraftSender({
  tgApiBase: `https://api.telegram.org/bot${telegramToken}`,
  emptyTextBehavior: "zero_width_space",
})
interface ActiveCodexRun {
  controller: AbortController
  process?: CodexProcessHandle
  stopRequested?: boolean
  abortRequested?: boolean
}

const activeResponses = new Map<number, ActiveCodexRun>()
const activeAgentRuns = new Map<string, ActiveCodexRun>()
const typingTimers = new Map<number, ReturnType<typeof setInterval>>()
const mediaCacheRoot = getMediaCacheRoot(process.env.MEDIA_CACHE_DIR)
const mediaGroupBuffer = new TelegramMediaGroupBuffer<TelegramMessageLike>(350)
let lastInboundAt = Date.now()

loadSessions()
loadSessionHistory()
loadSelectedModels()
loadSelectedReasoningEfforts()
loadExecutionApprovalModes()
loadChatWorkingDirectories()
loadChatPermissionModes()
loadChatWorkspaceHistory()
loadAgentProfiles()
loadCronJobs()
ensureMainMemoryFile()
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
const cronManager = new CodexCronManager({
  bot,
  codexBin,
  codexCwd: codexCwd || process.cwd(),
  defaultModel,
  defaultReasoningEffort: reasoningEffort,
  permissionMode,
})
cronManager.syncAll()
bot.setMyCommands([
  { command: "new", description: "♻️ 重置当前 Codex 会话" },
  { command: "sessions", description: "🧵 查看当前聊天的会话列表" },
  { command: "resume", description: "▶️ 切换到指定会话" },
  { command: "status", description: "📊 查看当前状态" },
  { command: "stop", description: "⛔ 中止当前 Codex 响应" },
  { command: "abort", description: "🧨 强制终止当前 Codex 进程" },
  { command: "models", description: "🤖 打开模型选择器" },
  { command: "model", description: "🛠 设置当前模型" },
  { command: "effort", description: "🧠 设置推理强度" },
  { command: "mode", description: "🔐 设置执行权限模式" },
  { command: "cwd", description: "📁 设置工作目录" },
  { command: "workspaces", description: "🗂 查看历史 workspace" },
  { command: "approval", description: "🛂 切换审批开关" },
  { command: "cron", description: "⏰ 管理本地定时任务" },
  { command: "memory", description: "🧾 查看主记忆" },
  { command: "agents", description: "🧩 查看本地 agent 列表" },
  { command: "agent", description: "⚙️ 新增或修改本地 agent" },
  { command: "delegate", description: "🚀 委派任务给本地 agent" },
  { command: "help", description: "📋 查看可用命令" },
]).catch((error) => {
  console.error("设置 Telegram 命令菜单失败:", error)
})
let cachedModels: CodexModelInfo[] = FALLBACK_CODEX_MODELS
const lastToolSummaryMap = new Map<number, string>()

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
  void bot.sendChatAction(chatId, "typing").catch(() => { })
  const timer = setInterval(() => {
    void bot.sendChatAction(chatId, "typing").catch(() => { })
  }, 4000)
  typingTimers.set(chatId, timer)
}

function getEffectiveModel(chatId: number) {
  return selectedModelMap.get(chatId) || defaultModel || FALLBACK_CODEX_MODELS.find((model) => model.isDefault)?.id || FALLBACK_CODEX_MODELS[0]!.id
}

function getKnownModels() {
  return cachedModels.length > 0 ? cachedModels : FALLBACK_CODEX_MODELS
}

function getModelInfo(modelId: string) {
  return getKnownModels().find((model) => model.id === modelId)
    || FALLBACK_CODEX_MODELS.find((model) => model.id === modelId)
    || FALLBACK_CODEX_MODELS[0]!
}

function getEffectiveReasoningEffort(chatId: number, modelId = getEffectiveModel(chatId)) {
  const model = getModelInfo(modelId)
  const selectedEffort = selectedReasoningEffortMap.get(chatId)
  if (selectedEffort && model.supportedEfforts.includes(selectedEffort)) {
    return selectedEffort
  }
  if (model.supportedEfforts.includes(reasoningEffort)) {
    return reasoningEffort
  }
  return model.defaultEffort || model.supportedEfforts[0] || "medium"
}

function getExecutionApprovalSetting(chatId: number) {
  return (executionApprovalModeMap.get(chatId) || executionApprovalMode) as ExecutionApprovalMode
}

function getEffectivePermissionMode(chatId: number) {
  return chatPermissionModeMap.get(chatId) || permissionMode
}

function getEffectiveCwd(chatId: number) {
  return chatWorkingDirectoryMap.get(chatId) || codexCwd || process.cwd()
}

function normalizePermissionMode(raw: string) {
  const value = raw.trim()
  if (["default", "clear", "__default__"].includes(value)) return "__default__" as const
  if (["bypass", "auto", "bypassPermissions"].includes(value)) return "bypassPermissions" as const
  if (["workspace", "workspace-write", "write"].includes(value)) return "workspace-write" as const
  if (["danger", "danger-full-access", "full"].includes(value)) return "danger-full-access" as const
  if (["read", "read-only", "readonly"].includes(value)) return "read-only" as const
  return null
}

function renderMemoryOverview() {
  const sections = readMainMemorySections()
  const labels = {
    about: "About",
    facts: "Facts",
    prefs: "Prefs",
  } as const

  const lines = ["<b>Main Memory</b>", ""]
  for (const key of ["about", "facts", "prefs"] as const) {
    lines.push(`<b>${labels[key]}</b>`)
    if (sections[key].length === 0) {
      lines.push("• (empty)")
    } else {
      sections[key].forEach((item, index) => {
        lines.push(`${index + 1}. ${escapeHtml(item)}`)
      })
    }
    lines.push("")
  }
  lines.push("用法：")
  lines.push("<code>/memory add prefs \"...\"</code>")
  lines.push("<code>/memory edit prefs 1 \"...\"</code>")
  lines.push("<code>/memory rm prefs 1</code>")
  lines.push("<code>/memory search keyword</code>")
  return lines.join("\n")
}

function renderSessions(chatId: number) {
  const currentSessionId = sessionMap.get(chatId)
  const currentWorkspace = getEffectiveCwd(chatId)
  const records = listChatSessions(chatId, { workspace: currentWorkspace })
  if (currentSessionId && !records.find((record) => record.id === currentSessionId)) {
    rememberSession(chatId, currentSessionId, { workspace: currentWorkspace })
  }

  const lines = [
    "<b>Codex 会话</b>",
    `当前 workspace：<code>${escapeHtml(currentWorkspace)}</code>`,
    `当前会话：<code>${escapeHtml(currentSessionId || "未建立")}</code>`,
    "",
  ]

  const nextRecords = listChatSessions(chatId, { workspace: currentWorkspace })
  if (nextRecords.length === 0) {
    lines.push("当前 workspace 还没有保存的会话记录。")
    return lines.join("\n")
  }

  for (const record of nextRecords.slice(0, 20)) {
    const currentMark = record.id === currentSessionId ? " [current]" : ""
    lines.push(`• <code>${escapeHtml(record.id)}</code>${currentMark}`)
    lines.push(`  ${escapeHtml(record.label)} · last=${escapeHtml(record.lastUsedAt)}`)
  }

  lines.push("")
  lines.push("用法：")
  lines.push("<code>/resume &lt;session-id&gt;</code>")
  lines.push("<code>/rename &lt;session-id&gt; \"新名字\"</code>")
  return lines.join("\n")
}

function renderAgents(chatId: number) {
  const profiles = listAgentProfiles(chatId)
  const lines = [
    "<b>本地 Agents</b>",
    `数量：<code>${profiles.length}</code>`,
    "",
  ]

  if (profiles.length === 0) {
    lines.push("当前还没有配置任何 agent。")
  } else {
    for (const profile of profiles.slice(0, 20)) {
      const running = activeAgentRuns.has(`${chatId}:${profile.name}`) ? " running" : ""
      lines.push(`• <code>${profile.name}</code>${running}`)
      lines.push(`  cwd=${escapeHtml(profile.cwd || getEffectiveCwd(chatId))} · model=${escapeHtml(profile.model || getEffectiveModel(chatId))}`)
    }
  }

  lines.push("")
  lines.push("用法：")
  lines.push("<code>/agent add reviewer --cwd \"/path\" --model gpt-5.4</code>")
  lines.push("<code>/agent set reviewer --reasoning-effort high</code>")
  lines.push("<code>/delegate reviewer \"review current diff\"</code>")
  return lines.join("\n")
}

function shortenWorkspacePath(workspace: string) {
  if (workspace.length <= 72) return workspace
  return `...${workspace.slice(-69)}`
}

function shortenInlineLabel(value: string, maxLength = 24) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`
}

function buildSessionButtonLabel(record: { id: string; label: string }, currentSessionId?: string) {
  const prefix = record.id === currentSessionId ? "✅" : "▶️"
  return `${prefix} ${shortenInlineLabel(record.label || record.id, 22)}`
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
      { text: `${index + 1}. ${path.basename(workspace) || workspace}`, callback_data: `codex-workspace:${index}` },
    ]),
    ...workspaceSessions.slice(0, 6).map((record) => [
      { text: buildSessionButtonLabel(record, currentSessionId), callback_data: `codex-session:${record.id}` },
    ]),
    [{ text: "🧹 清空历史", callback_data: "codex-workspace:__clear__" }],
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

async function runDelegatedAgent(chatId: number, agentName: string, promptText: string) {
  const profile = getAgentProfile(chatId, agentName)
  if (!profile) {
    await bot.sendMessage(chatId, `⚠️ 未找到 agent：${agentName}`).catch(() => { })
    return
  }

  const key = `${chatId}:${profile.name}`
  if (activeAgentRuns.has(key)) {
    await bot.sendMessage(chatId, `⏳ agent ${profile.name} 已在执行中。`).catch(() => { })
    return
  }

  const controller = new AbortController()
  const activeRun: ActiveCodexRun = { controller }
  activeAgentRuns.set(key, activeRun)
  await bot.sendMessage(chatId, `🚀 agent <code>${escapeHtml(profile.name)}</code> 已开始执行。`, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  }).catch(() => { })

  try {
    const response = await runCodexPrompt({
      prompt: [
        "You are acting as a delegated Codex agent for a Telegram user.",
        `Agent name: ${profile.name}`,
        "",
        promptText.trim(),
      ].join("\n"),
      resume: profile.sessionId,
      model: profile.model || getEffectiveModel(chatId),
      cwd: profile.cwd || getEffectiveCwd(chatId),
      codexBin,
      reasoningEffort: profile.reasoningEffort || getEffectiveReasoningEffort(chatId),
      permissionMode: getEffectivePermissionMode(chatId),
      signal: controller.signal,
      onSpawn: (handle) => {
        activeRun.process = handle
      },
    })

    upsertAgentProfile(chatId, {
      name: profile.name,
      cwd: profile.cwd,
      model: profile.model,
      reasoningEffort: profile.reasoningEffort,
      sessionId: response.sessionId || profile.sessionId,
      lastRunAt: new Date().toISOString(),
    })

    await deliverCodexTextResult({
      bot,
      chatId,
      text: `🧩 Agent ${profile.name}\n\n${response.text || "已完成，但没有返回正文。"}`,
      prefix: `agent-${profile.name}`,
      caption: `🧩 Agent ${profile.name} 输出较长，已作为文件发送。`,
    })
  } catch (error) {
    if (!activeRun.abortRequested && !controller.signal.aborted) {
      await bot.sendMessage(chatId, buildSessionErrorNotice({
        titleHtml: `⚠️ <b>Agent 执行失败</b>`,
        rawMessage: error instanceof Error ? error.message : String(error),
      }), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }).catch(() => { })
    }
  } finally {
    activeAgentRuns.delete(key)
  }
}

async function refreshModels() {
  cachedModels = await discoverCodexModels({ codexBin }).catch(() => FALLBACK_CODEX_MODELS)
  return getKnownModels()
}

function getRequestAddDirectories() {
  return [...new Set(extraAddDirectories)]
}

function getImageAttachments(attachments: ResolvedTelegramAttachment[]) {
  return attachments.filter((attachment) => attachment.mime.startsWith("image/")).map((attachment) => attachment.path)
}

function createDraftId() {
  return Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 100000) + 1
}

function buildMediaCacheKey(normalized: Pick<NormalizedInboundMessage, "chatId" | "mediaGroupId" | "messageIds">) {
  const unique = normalized.mediaGroupId || normalized.messageIds.join("-")
  return `chat-${normalized.chatId}-${unique}`
}

function getAttachmentCacheRoot(chatId: number) {
  return path.join(getEffectiveCwd(chatId), ".codex-telegram-media")
}

function buildWelcomeMessage(chatId: number) {
  return [
    "<b>Codex Bot</b>",
    "",
    `当前模型：<code>${getEffectiveModel(chatId)}</code>`,
    `推理强度：<code>${getEffectiveReasoningEffort(chatId)}</code>`,
    `权限模式：<code>${getEffectivePermissionMode(chatId)}</code>`,
    `工作目录：<code>${escapeHtml(getEffectiveCwd(chatId))}</code>`,
    "可用命令：",
    "/model - 切换模型",
    "/models - 打开模型选择器",
    "/effort - 切换推理强度",
    "/mode - 切换权限模式",
    "/cwd - 切换工作目录",
    "/workspaces - 查看历史 workspace",
    "/approval - 切换审批开关",
    "/cron - 管理本地定时任务",
    "/memory - 查看主记忆",
    "/agents - 查看本地 agent",
    "/agent - 新增或修改 agent",
    "/delegate - 委派任务给 agent",
    "/sessions - 查看会话列表",
    "/new - 新建会话",
    "/stop - 中止当前请求",
    "/abort - 强制终止当前进程",
    "/status - 查看当前状态",
    "",
    "也可以直接发送图片或文件给 Codex。",
  ].join("\n")
}

function buildCronHelpMessage() {
  return [
    "<b>Cron 命令</b>",
    "",
    "<code>/cron list</code> - 查看所有定时任务",
    "<code>/cron time</code> - 查看当前时区/时间基准",
    "<code>/cron enable &lt;job-id&gt;</code> - 启用任务",
    "<code>/cron disable &lt;job-id&gt;</code> - 禁用任务",
    "<code>/cron run &lt;job-id&gt;</code> - 立即执行一次",
    "<code>/cron logs &lt;job-id&gt;</code> - 发送最近一次运行日志",
    "<code>/cron edit &lt;job-id&gt; --schedule \"...\" --model ...</code> - 修改任务元数据",
    "<code>/cron clone &lt;job-id&gt; --name \"...\"</code> - 复制任务",
    "<code>/cron remove &lt;job-id&gt; --yes</code> - 删除任务",
    "<code>/cron add --name \"...\" --title \"...\" --description \"...\" --schedule \"0 9 * * *\" --model gpt-5.4 --reasoning-effort high</code>",
  ].join("\n")
}

function renderCronList() {
  const jobs = Array.from(cronJobMap.values()).sort((a, b) => a.id.localeCompare(b.id))
  const lines = [
    "<b>Cron 任务列表</b>",
    `数量：<code>${jobs.length}</code>`,
    "",
  ]

  if (jobs.length === 0) {
    lines.push("当前没有配置任何定时任务。")
    return lines.join("\n")
  }

  for (const job of jobs.slice(0, 20)) {
    const enabled = job.enabled ? "enabled" : "disabled"
    const last = job.lastRunAt ? `${job.lastRunStatus || "unknown"} @ ${job.lastRunAt}` : "never"
    const running = cronManager.isRunning(job.id) ? " running" : ""
    lines.push(`• <code>${job.id}</code> [${enabled}${running}] ${job.schedule}`)
    lines.push(`  ${escapeHtml(job.title)} · last=${escapeHtml(last)}${job.lastRunLogFile ? " · log=latest" : ""}`)
  }
  return lines.join("\n")
}

function renderCronTime() {
  const now = new Date()
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  return [
    "<b>Cron 时间基准</b>",
    `时区：<code>${escapeHtml(zone)}</code>`,
    `当前时间：<code>${escapeHtml(now.toLocaleString())}</code>`,
    `UTC：<code>${escapeHtml(now.toISOString())}</code>`,
  ].join("\n")
}

async function sendModelPicker(chatId: number, editTarget?: { messageId: number }) {
  const discoveredModels = await refreshModels()
  const allowedModels = [...new Set((discoveredModels.length > 0 ? discoveredModels : FALLBACK_CODEX_MODELS).map((model) => model.id))]
  const picker = buildCodexModelPickerMessage({
    allowedModels,
    currentModel: getEffectiveModel(chatId),
    currentEffort: getEffectiveReasoningEffort(chatId),
    defaultModel,
  })

  if (editTarget) {
    const edited = await editMessageTextSafe(bot as any, chatId, editTarget.messageId, picker.text, picker.options)
    if (edited) return
  }

  await bot.sendMessage(chatId, picker.text, picker.options).catch(() => { })
}

async function sendEffortPicker(chatId: number, modelId?: string, editTarget?: { messageId: number }) {
  await refreshModels()
  const model = getModelInfo(modelId || getEffectiveModel(chatId))
  const picker = buildCodexEffortPickerMessage({
    model,
    currentEffort: getEffectiveReasoningEffort(chatId, model.id),
    fallbackEffort: reasoningEffort,
  })

  if (editTarget) {
    const edited = await editMessageTextSafe(bot as any, chatId, editTarget.messageId, picker.text, picker.options)
    if (edited) return
  }

  await bot.sendMessage(chatId, picker.text, picker.options).catch(() => { })
}

async function sendAttachmentPreview(chatId: number, attachments: ResolvedTelegramAttachment[]) {
  if (attachments.length === 0) return
  const message = buildAttachmentPreviewMessage(attachments)
  await bot.sendMessage(chatId, message, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  }).catch(() => { })
}

async function requestExecutionApproval(chatId: number, userText: string, attachments: ResolvedTelegramAttachment[]) {
  const token = createApprovalToken()
  const replaced = setPendingApproval({
    token,
    chatId,
    userText,
    attachments,
    createdAt: Date.now(),
  })

  if (replaced) {
    scheduleAttachmentCleanup(replaced.attachments.map((attachment) => attachment.path))
  }

  const prompt = buildExecutionApprovalMessage({
    token,
    userText,
    model: getEffectiveModel(chatId),
    effort: getEffectiveReasoningEffort(chatId),
    permissionMode: getEffectivePermissionMode(chatId),
    attachments,
  })

  await bot.sendMessage(chatId, prompt.text, prompt.options).catch(() => { })
}

async function handlePrompt(chatId: number, userText: string, attachments: ResolvedTelegramAttachment[]) {
  if (activeResponses.has(chatId)) {
    await bot.sendMessage(chatId, "⏳ 当前会话还有一个 Codex 请求在执行，请先发送 /stop 或等待完成。").catch(() => { })
    return
  }

  const controller = new AbortController()
  const activeRun: ActiveCodexRun = { controller }
  activeResponses.set(chatId, activeRun)
  startTyping(chatId)

  const resumeSessionId = sessionMap.get(chatId)
  const toolTracker = new ToolStatusTracker()
  const draftId = createDraftId()
  const draftState = new CodexDraftState()
  let lastDraftText = ""
  let lastDraftAt = 0

  try {
    rememberChatWorkspace(chatId, getEffectiveCwd(chatId))
    logInfo("TG.CODEX.REQUEST", {
      chatId,
      resumeSessionId,
      model: getEffectiveModel(chatId),
      attachmentCount: attachments.length,
    })

    const mainMemory = resumeSessionId ? "" : readMainMemory().trim()
    const response = await runCodexPrompt({
      prompt: buildCodexPrompt({ userText, attachments, mainMemory }),
      model: getEffectiveModel(chatId),
      resume: resumeSessionId,
      cwd: getEffectiveCwd(chatId),
      codexBin,
      reasoningEffort: getEffectiveReasoningEffort(chatId),
      permissionMode: getEffectivePermissionMode(chatId),
      images: getImageAttachments(attachments),
      addDirectories: getRequestAddDirectories(),
      signal: controller.signal,
      onSpawn: (handle) => {
        activeRun.process = handle
      },
      onEvent: (event: CodexStreamEvent) => {
        draftState.applyEvent(event)
        if (event.type === "tool_use" && event.toolName) {
          toolTracker.addToolUse(event.toolName)
          lastToolSummaryMap.set(chatId, toolTracker.renderPlain())
          void sendRenderedAssistantPart(bot as any, chatId, "status", toolTracker.renderPlain())
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

    await sendDraft(chatId, draftId, "").catch(() => { })

    if (response.sessionId) {
      rememberSession(chatId, response.sessionId, { workspace: getEffectiveCwd(chatId) })
    }

    if (response.sessionId && response.sessionId !== resumeSessionId) {
      setChatSession(chatId, response.sessionId)
      saveSessions()
    }

    const text = response.text || "Codex 已完成，但没有返回可显示的正文。"
    await deliverCodexTextResult({
      bot,
      chatId,
      text,
      prefix: `codex-chat-${chatId}`,
      caption: "📄 输出较长，已作为文件发送。",
    })
  } catch (error) {
    await sendDraft(chatId, draftId, "").catch(() => { })
    if (activeRun.stopRequested || activeRun.abortRequested || controller.signal.aborted) return
    logError("TG.CODEX.REQUEST_FAILED", {
      chatId,
      sessionId: sessionMap.get(chatId),
    }, error)

    await bot.sendMessage(chatId, buildSessionErrorNotice({
      titleHtml: "⚠️ <b>Codex 处理失败</b>",
      rawMessage: error instanceof Error ? error.message : String(error),
    }), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }).catch(() => { })
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
    }).catch(() => { })
    return true
  }

  if (cmd === "/memory") {
    const normalizedArgs = args.trim()
    if (!normalizedArgs) {
      await bot.sendMessage(chatId, renderMemoryOverview(), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }).catch(() => { })
      return true
    }

    const [subcommand, ...restParts] = tokenizeCronArgs(normalizedArgs)
    if (subcommand === "add") {
      const section = normalizeMemorySection(restParts[0] || "")
      const text = restParts.slice(1).join(" ").trim()
      if (!section || !text) {
        await bot.sendMessage(chatId, "⚠️ 用法：/memory add <about|facts|prefs> \"内容\"").catch(() => { })
        return true
      }
      const index = addMainMemoryItem(section, text)
      await bot.sendMessage(chatId, `✅ 已写入 ${section} #${index}`).catch(() => { })
      return true
    }

    if (subcommand === "edit") {
      const section = normalizeMemorySection(restParts[0] || "")
      const index = Number(restParts[1])
      const text = restParts.slice(2).join(" ").trim()
      if (!section || !Number.isInteger(index) || index < 1 || !text) {
        await bot.sendMessage(chatId, "⚠️ 用法：/memory edit <about|facts|prefs> <index> \"新内容\"").catch(() => { })
        return true
      }
      const updated = editMainMemoryItem(section, index, text)
      await bot.sendMessage(chatId, updated ? `✅ 已更新 ${section} #${index}` : `⚠️ 未找到 ${section} #${index}`).catch(() => { })
      return true
    }

    if (subcommand === "rm") {
      const section = normalizeMemorySection(restParts[0] || "")
      const index = Number(restParts[1])
      if (!section || !Number.isInteger(index) || index < 1) {
        await bot.sendMessage(chatId, "⚠️ 用法：/memory rm <about|facts|prefs> <index>").catch(() => { })
        return true
      }
      const removed = removeMainMemoryItem(section, index)
      await bot.sendMessage(chatId, removed ? `🗑 已删除 ${section} #${index}` : `⚠️ 未找到 ${section} #${index}`).catch(() => { })
      return true
    }

    if (subcommand === "search") {
      const query = restParts.join(" ").trim()
      if (!query) {
        await bot.sendMessage(chatId, "⚠️ 用法：/memory search <关键词>").catch(() => { })
        return true
      }
      const matches = searchMainMemory(query)
      if (matches.length === 0) {
        await bot.sendMessage(chatId, "没有匹配的记忆条目。").catch(() => { })
        return true
      }
      await bot.sendMessage(chatId, [
        `<b>Memory 搜索</b>`,
        `关键词：<code>${escapeHtml(query)}</code>`,
        "",
        ...matches.slice(0, 20).map((match) => `${match.section} #${match.index} · ${escapeHtml(match.text)}`),
      ].join("\n"), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }).catch(() => { })
      return true
    }

    await bot.sendMessage(chatId, renderMemoryOverview(), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }).catch(() => { })
    return true
  }

  if (cmd === "/new") {
    const clearedApproval = clearPendingApproval(chatId)
    if (clearedApproval) {
      scheduleAttachmentCleanup(clearedApproval.attachments.map((attachment) => attachment.path))
    }
    clearChatSession(chatId)
    await bot.sendMessage(chatId, "🆕 已清空当前 Codex 会话。下一条消息会新建线程。").catch(() => { })
    return true
  }

  if (cmd === "/sessions") {
    await bot.sendMessage(chatId, renderSessions(chatId), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }).catch(() => { })
    return true
  }

  if (cmd === "/agents") {
    await bot.sendMessage(chatId, renderAgents(chatId), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }).catch(() => { })
    return true
  }

  if (cmd === "/resume") {
    const sessionId = tokenizeCronArgs(args.trim())[0]
    if (!sessionId) {
      await bot.sendMessage(chatId, "⚠️ 用法：/resume <session-id>").catch(() => { })
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
    }).catch(() => { })
    return true
  }

  if (cmd === "/agent") {
    const tokens = tokenizeCronArgs(args.trim())
    const subcommand = tokens[0]

    if (!subcommand) {
      await bot.sendMessage(chatId, renderAgents(chatId), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }).catch(() => { })
      return true
    }

    if (subcommand === "add" || subcommand === "set") {
      const name = tokens[1]
      if (!name) {
        await bot.sendMessage(chatId, `⚠️ 用法：/agent ${subcommand} <name> [--cwd ...] [--model ...] [--reasoning-effort ...]`).catch(() => { })
        return true
      }
      const parsed = parseCronOptionArgs(tokens.slice(2))
      const cwd = parsed.values.get("--cwd")
      const model = parsed.values.get("--model")
      const effort = parsed.values.get("--reasoning-effort")
      const resolvedCwd = cwd ? path.resolve(getEffectiveCwd(chatId), cwd) : undefined
      if (resolvedCwd && (!fs.existsSync(resolvedCwd) || !fs.statSync(resolvedCwd).isDirectory())) {
        await bot.sendMessage(chatId, `⚠️ 目录不存在：${resolvedCwd}`).catch(() => { })
        return true
      }
      try {
        const profile = upsertAgentProfile(chatId, {
          name,
          cwd: resolvedCwd,
          model,
          reasoningEffort: effort,
        })
        await bot.sendMessage(chatId, `✅ agent 已保存：<code>${escapeHtml(profile?.name || name)}</code>`, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        }).catch(() => { })
      } catch (error) {
        await bot.sendMessage(chatId, `⚠️ 保存 agent 失败：${error instanceof Error ? error.message : String(error)}`).catch(() => { })
      }
      return true
    }

    if (subcommand === "rm") {
      const name = tokens[1]
      const confirmed = tokens.includes("--yes")
      if (!name) {
        await bot.sendMessage(chatId, "⚠️ 用法：/agent rm <name> --yes").catch(() => { })
        return true
      }
      if (!confirmed) {
        await bot.sendMessage(chatId, `⚠️ 删除 agent 是破坏性操作。确认请发送：/agent rm ${name} --yes`).catch(() => { })
        return true
      }
      const removed = removeAgentProfile(chatId, name)
      await bot.sendMessage(chatId, removed ? `🗑 已删除 agent：${removed}` : `⚠️ 未找到 agent：${name}`).catch(() => { })
      return true
    }

    await bot.sendMessage(chatId, renderAgents(chatId), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }).catch(() => { })
    return true
  }

  if (cmd === "/delegate") {
    const tokens = tokenizeCronArgs(args.trim())
    const agentName = tokens[0]
    const promptText = tokens.slice(1).join(" ").trim()
    if (!agentName || !promptText) {
      await bot.sendMessage(chatId, "⚠️ 用法：/delegate <agent-name> \"任务描述\"").catch(() => { })
      return true
    }
    void runDelegatedAgent(chatId, agentName, promptText)
    return true
  }

  if (cmd === "/rename") {
    const tokens = tokenizeCronArgs(args.trim())
    const sessionId = tokens[0]
    const label = tokens.slice(1).join(" ").trim()
    if (!sessionId || !label) {
      await bot.sendMessage(chatId, "⚠️ 用法：/rename <session-id> \"新名字\"").catch(() => { })
      return true
    }
    if (!getSessionRecord(chatId, sessionId)) {
      rememberSession(chatId, sessionId, { workspace: getEffectiveCwd(chatId) })
    }
    const renamed = renameSession(chatId, sessionId, label)
    await bot.sendMessage(chatId, renamed ? `🏷 已重命名会话：<code>${escapeHtml(sessionId)}</code> -> ${escapeHtml(renamed.label)}` : `⚠️ 未找到会话：${escapeHtml(sessionId)}`, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }).catch(() => { })
    return true
  }

  if (cmd === "/stop") {
    const activeRun = activeResponses.get(chatId)
    if (!activeRun) {
      await bot.sendMessage(chatId, "当前没有正在执行的 Codex 请求。").catch(() => { })
      return true
    }
    activeRun.stopRequested = true
    activeRun.process?.interrupt()
    await bot.sendMessage(chatId, "🛑 已请求优雅停止当前 Codex 请求。").catch(() => { })
    return true
  }

  if (cmd === "/abort") {
    const activeRun = activeResponses.get(chatId)
    if (!activeRun) {
      await bot.sendMessage(chatId, "当前没有正在执行的 Codex 请求。").catch(() => { })
      return true
    }
    activeRun.abortRequested = true
    activeRun.process?.terminate()
    activeRun.controller.abort()
    activeResponses.delete(chatId)
    stopTyping(chatId)
    await bot.sendMessage(chatId, "🧨 已强制终止当前 Codex 进程。").catch(() => { })
    return true
  }

  if (cmd === "/status") {
    const activeRun = activeResponses.get(chatId)
    const sessionRecord = sessionMap.get(chatId) ? getSessionRecord(chatId, sessionMap.get(chatId)!) : null
    const lines = [
      "<b>Codex Bot 状态</b>",
      `当前模型：<code>${getEffectiveModel(chatId)}</code>`,
      `推理强度：<code>${getEffectiveReasoningEffort(chatId)}</code>`,
      `当前线程：<code>${sessionMap.get(chatId) || "未建立"}</code>`,
      `线程标签：<code>${escapeHtml(sessionRecord?.label || "未命名")}</code>`,
      `Codex CLI：<code>${codexBin}</code>`,
      `工作目录：<code>${escapeHtml(getEffectiveCwd(chatId))}</code>`,
      `权限模式：<code>${getEffectivePermissionMode(chatId)}</code>`,
      `审批模式：<code>${getExecutionApprovalSetting(chatId)}</code>`,
      `执行状态：<code>${activeResponses.has(chatId) ? "进行中" : "空闲"}</code>`,
      `当前进程：<code>${activeRun?.process?.pid || "无"}</code>`,
      `待审批：<code>${hasPendingApproval(chatId) ? "是" : "否"}</code>`,
      `最近工具：<code>${lastToolSummaryMap.get(chatId) || "无"}</code>`,
    ]
    await bot.sendMessage(chatId, lines.join("\n"), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }).catch(() => { })
    return true
  }

  if (cmd === "/models") {
    await sendModelPicker(chatId)
    return true
  }

  if (cmd === "/mode") {
    const nextMode = normalizePermissionMode(args.trim())
    if (!args.trim()) {
      await bot.sendMessage(chatId, `当前权限模式：<code>${getEffectivePermissionMode(chatId)}</code>\n可用：bypassPermissions / workspace-write / danger-full-access / read-only`, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }).catch(() => { })
      return true
    }
    if (!nextMode) {
      await bot.sendMessage(chatId, "⚠️ 用法：/mode <bypassPermissions|workspace-write|danger-full-access|read-only>").catch(() => { })
      return true
    }
    if (nextMode === "__default__") {
      chatPermissionModeMap.delete(chatId)
      saveChatPermissionModes()
      await bot.sendMessage(chatId, `↺ 已恢复默认权限模式：${getEffectivePermissionMode(chatId)}`).catch(() => { })
      return true
    }
    chatPermissionModeMap.set(chatId, nextMode)
    saveChatPermissionModes()
    await bot.sendMessage(chatId, `✅ 当前聊天权限模式已切换为：${nextMode}`).catch(() => { })
    return true
  }

  if (cmd === "/workspaces") {
    const normalizedArgs = args.trim().toLowerCase()
    if (normalizedArgs === "clear") {
      clearChatWorkspaceHistory(chatId)
      await bot.sendMessage(chatId, "🧹 已清空当前聊天的 workspace 历史。").catch(() => { })
      return true
    }
    const message = buildWorkspaceHistoryMessage(chatId)
    await bot.sendMessage(chatId, message.text, message.options).catch(() => { })
    return true
  }

  if (cmd === "/cwd") {
    const normalizedArgs = args.trim()
    if (!normalizedArgs) {
      const message = buildWorkspaceHistoryMessage(chatId)
      await bot.sendMessage(chatId, message.text, message.options).catch(() => { })
      return true
    }
    if (["clear", "default", "__default__"].includes(normalizedArgs)) {
      chatWorkingDirectoryMap.delete(chatId)
      saveChatWorkingDirectories()
      await bot.sendMessage(chatId, `↺ 已恢复默认工作目录：${escapeHtml(getEffectiveCwd(chatId))}`, {
        parse_mode: "HTML",
      }).catch(() => { })
      return true
    }
    const tokens = tokenizeCronArgs(normalizedArgs)
    const rawPath = tokens[0] === "set" ? tokens.slice(1).join(" ").trim() : normalizedArgs
    if (!rawPath) {
      await bot.sendMessage(chatId, "⚠️ 用法：/cwd set <path>").catch(() => { })
      return true
    }
    const resolvedPath = path.resolve(getEffectiveCwd(chatId), rawPath)
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
      await bot.sendMessage(chatId, `⚠️ 目录不存在：${resolvedPath}`).catch(() => { })
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
    }).catch(() => { })
    return true
  }

  if (cmd === "/cron") {
    const normalizedArgs = args.trim()
    if (!normalizedArgs) {
      await bot.sendMessage(chatId, buildCronHelpMessage(), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }).catch(() => { })
      return true
    }

    const [subcommand, ...restParts] = tokenizeCronArgs(normalizedArgs)

    if (subcommand === "list") {
      await bot.sendMessage(chatId, renderCronList(), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }).catch(() => { })
      return true
    }

    if (subcommand === "time") {
      await bot.sendMessage(chatId, renderCronTime(), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }).catch(() => { })
      return true
    }

    if (subcommand === "run") {
      const jobId = restParts[0]
      const job = jobId ? cronJobMap.get(jobId) : null
      if (!job) {
        await bot.sendMessage(chatId, `⚠️ 未找到 cron job：${jobId || "(empty)"}`).catch(() => { })
        return true
      }
      if (cronManager.isRunning(jobId)) {
        await bot.sendMessage(chatId, `⏳ cron 正在执行：${jobId}`).catch(() => { })
        return true
      }
      await bot.sendMessage(chatId, `▶️ 已手动触发 cron：${jobId}`).catch(() => { })
      void cronManager.runJob(jobId)
      return true
    }

    if (subcommand === "logs") {
      const jobId = restParts[0]
      const job = jobId ? cronJobMap.get(jobId) : null
      if (!job) {
        await bot.sendMessage(chatId, `⚠️ 未找到 cron job：${jobId || "(empty)"}`).catch(() => { })
        return true
      }
      if (!job.lastRunLogFile || !fs.existsSync(job.lastRunLogFile)) {
        await bot.sendMessage(chatId, `当前没有可发送的运行日志：${jobId}`).catch(() => { })
        return true
      }
      await bot.sendDocument(chatId, job.lastRunLogFile, {
        caption: `${job.id} latest log`,
      } as any).catch(() => { })
      return true
    }

    if (subcommand === "enable" || subcommand === "disable") {
      const jobId = restParts[0]
      if (!jobId) {
        await bot.sendMessage(chatId, `⚠️ 用法：/cron ${subcommand} <job-id>`).catch(() => { })
        return true
      }
      const updated = updateCronJob(jobId, (job) => ({ ...job, enabled: subcommand === "enable" }))
      if (!updated) {
        await bot.sendMessage(chatId, `⚠️ 未找到 cron job：${jobId}`).catch(() => { })
        return true
      }
      cronManager.syncAll()
      await bot.sendMessage(chatId, subcommand === "enable" ? `✅ 已启用 cron：${jobId}` : `⏸ 已禁用 cron：${jobId}`).catch(() => { })
      return true
    }

    if (subcommand === "remove") {
      const filtered = restParts.filter((part) => part !== "--yes")
      const jobId = filtered[0]
      const confirmed = restParts.includes("--yes")
      if (!jobId) {
        await bot.sendMessage(chatId, "⚠️ 用法：/cron remove <job-id> --yes").catch(() => { })
        return true
      }
      if (!confirmed) {
        await bot.sendMessage(chatId, `⚠️ 删除 cron 是破坏性操作。确认请发送：/cron remove ${jobId} --yes`).catch(() => { })
        return true
      }
      const removed = removeCronJob(jobId)
      if (!removed) {
        await bot.sendMessage(chatId, `⚠️ 未找到 cron job：${jobId}`).catch(() => { })
        return true
      }
      cronManager.syncAll()
      await bot.sendMessage(chatId, `🗑 已删除 cron：${jobId}`).catch(() => { })
      return true
    }

    if (subcommand === "edit") {
      const jobId = restParts[0]
      const existing = jobId ? cronJobMap.get(jobId) : null
      if (!existing) {
        await bot.sendMessage(chatId, `⚠️ 未找到 cron job：${jobId || "(empty)"}`).catch(() => { })
        return true
      }
      const parsed = parseCronOptionArgs(restParts.slice(1))
      const title = parsed.values.get("--title")
      const description = parsed.values.get("--description")
      const schedule = parsed.values.get("--schedule")
      const model = parsed.values.get("--model")
      const effort = parsed.values.get("--reasoning-effort")

      if (!title && !description && !schedule && !model && !effort) {
        await bot.sendMessage(chatId, "⚠️ 用法：/cron edit <job-id> [--title ...] [--description ...] [--schedule ...] [--model ...] [--reasoning-effort ...]").catch(() => { })
        return true
      }

      const updated = updateCronJob(jobId, (job) => ({
        ...job,
        title: title?.trim() || job.title,
        description: description?.trim() || job.description,
        schedule: schedule?.trim() || job.schedule,
        model: model?.trim() || job.model,
        reasoningEffort: effort?.trim() || job.reasoningEffort,
      }))

      if (!updated) {
        await bot.sendMessage(chatId, `⚠️ 未找到 cron job：${jobId}`).catch(() => { })
        return true
      }

      cronManager.syncAll()
      await bot.sendMessage(chatId, `✅ 已更新 cron：<code>${updated.id}</code>\n计划：<code>${escapeHtml(updated.schedule)}</code>`, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }).catch(() => { })
      return true
    }

    if (subcommand === "clone") {
      const sourceId = restParts[0]
      const source = sourceId ? cronJobMap.get(sourceId) : null
      if (!source) {
        await bot.sendMessage(chatId, `⚠️ 未找到 cron job：${sourceId || "(empty)"}`).catch(() => { })
        return true
      }

      const parsed = parseCronOptionArgs(restParts.slice(1))
      const name = parsed.values.get("--name")
      if (!name) {
        await bot.sendMessage(chatId, "⚠️ 用法：/cron clone <job-id> --name \"new-id\" [--schedule ...]").catch(() => { })
        return true
      }

      try {
        const cloned = addCronJob({
          id: name,
          title: parsed.values.get("--title") || `${source.title} (copy)`,
          description: parsed.values.get("--description") || source.description,
          schedule: parsed.values.get("--schedule") || source.schedule,
          chatId,
          model: parsed.values.get("--model") || source.model,
          reasoningEffort: parsed.values.get("--reasoning-effort") || source.reasoningEffort,
        })
        writeCronTaskFile(cloned.taskFile, readCronTaskFile(source.taskFile))
        cronManager.syncAll()
        await bot.sendMessage(chatId, `✅ 已复制 cron：<code>${source.id}</code> -> <code>${cloned.id}</code>`, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        }).catch(() => { })
      } catch (error) {
        await bot.sendMessage(chatId, `⚠️ 复制 cron 失败：${error instanceof Error ? error.message : String(error)}`).catch(() => { })
      }
      return true
    }

    if (subcommand === "add") {
      if (restParts.length === 0) {
        await bot.sendMessage(chatId, buildCronHelpMessage(), {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        }).catch(() => { })
        return true
      }

      const parsed = parseCronOptionArgs(restParts)
      const name = parsed.values.get("--name")
      const title = parsed.values.get("--title")
      const description = parsed.values.get("--description")
      const schedule = parsed.values.get("--schedule")
      const provider = parsed.values.get("--provider")
      const model = parsed.values.get("--model")
      const effort = parsed.values.get("--reasoning-effort")

      if (provider && provider !== "codex") {
        await bot.sendMessage(chatId, "⚠️ codex-bot 的本地 cron 目前只支持 provider=codex。").catch(() => { })
        return true
      }

      if (!name || !title || !description || !schedule) {
        await bot.sendMessage(chatId, "⚠️ 缺少必填参数。至少需要 --name --title --description --schedule。", {
          parse_mode: "HTML",
        }).catch(() => { })
        return true
      }

      try {
        const job = addCronJob({
          id: name,
          title,
          description,
          schedule,
          chatId,
          model,
          reasoningEffort: effort,
        })
        cronManager.syncAll()
        await bot.sendMessage(
          chatId,
          `✅ 已创建 cron：<code>${job.id}</code>\n计划：<code>${escapeHtml(job.schedule)}</code>\n任务文件：<code>${escapeHtml(job.taskFile)}</code>`,
          {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          },
        ).catch(() => { })
      } catch (error) {
        await bot.sendMessage(chatId, `⚠️ 创建 cron 失败：${error instanceof Error ? error.message : String(error)}`).catch(() => { })
      }
      return true
    }

    await bot.sendMessage(chatId, buildCronHelpMessage(), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }).catch(() => { })
    return true
  }

  if (cmd === "/approval") {
    const normalizedArgs = args.trim().toLowerCase()
    if (!normalizedArgs) {
      await bot.sendMessage(chatId, `当前审批模式：${getExecutionApprovalSetting(chatId)}\n可用：/approval auto 或 /approval prompt`).catch(() => { })
      return true
    }

    if (normalizedArgs !== "auto" && normalizedArgs !== "prompt") {
      await bot.sendMessage(chatId, "⚠️ 仅支持 /approval auto 或 /approval prompt").catch(() => { })
      return true
    }

    executionApprovalModeMap.set(chatId, normalizedArgs)
    saveExecutionApprovalModes()
    await bot.sendMessage(
      chatId,
      normalizedArgs === "auto" ? "✅ 已关闭审批弹窗，后续请求将直接执行。" : "🛂 已开启审批弹窗，后续请求需要先批准。",
    ).catch(() => { })
    return true
  }

  if (cmd === "/effort") {
    const normalizedArgs = args.trim()

    if (!normalizedArgs) {
      await sendEffortPicker(chatId)
      return true
    }

    const model = getModelInfo(getEffectiveModel(chatId))
    if (normalizedArgs === "default" || normalizedArgs === "clear" || normalizedArgs === "__default__") {
      selectedReasoningEffortMap.delete(chatId)
      saveSelectedReasoningEfforts()
      await bot.sendMessage(chatId, `↺ 已恢复使用默认推理强度：${getEffectiveReasoningEffort(chatId)}`).catch(() => { })
      return true
    }

    if (!model.supportedEfforts.includes(normalizedArgs)) {
      await bot.sendMessage(chatId, `⚠️ 当前模型不支持该推理强度：${normalizedArgs}`).catch(() => { })
      return true
    }

    selectedReasoningEffortMap.set(chatId, normalizedArgs)
    saveSelectedReasoningEfforts()
    await bot.sendMessage(chatId, `✅ 当前聊天推理强度已切换为：${normalizedArgs}`).catch(() => { })
    return true
  }

  if (cmd === "/model") {
    const normalizedArgs = args.trim()

    if (!normalizedArgs) {
      await sendModelPicker(chatId)
      return true
    }

    const nextModel = normalizedArgs.startsWith("set ") ? normalizedArgs.slice(4).trim() : normalizedArgs
    if (nextModel === "clear" || nextModel === "default" || nextModel === "__default__") {
      selectedModelMap.delete(chatId)
      saveSelectedModels()
      await bot.sendMessage(chatId, `↺ 已恢复使用默认模型：${getEffectiveModel(chatId)}`).catch(() => { })
      await sendEffortPicker(chatId)
      return true
    }

    selectedModelMap.set(chatId, nextModel)
    saveSelectedModels()
    await bot.sendMessage(chatId, `✅ 当前聊天模型已切换为：${nextModel}`).catch(() => { })
    await sendEffortPicker(chatId, nextModel)
    return true
  }

  return false
}

bot.on("callback_query", async (query) => {
  if (!isAllowedUser(query.from?.id)) return

  const data = String(query.data || "")
  if (!data.startsWith("codex-model:") && !data.startsWith("codex-effort:") && !data.startsWith("codex-approve:") && !data.startsWith("codex-workspace:")) return

  const chatId = query.message?.chat.id
  const messageId = query.message?.message_id
  if (!chatId || !messageId) {
    await answerCallbackQuerySafe(bot as any, query.id, "无法定位这条消息。")
    return
  }

  if (data.startsWith("codex-approve:")) {
    const [, action, token] = data.split(":")
    const approval = token ? getPendingApproval(token) : null
    if (!approval || approval.chatId !== chatId) {
      await answerCallbackQuerySafe(bot as any, query.id, "这条审批已经失效。")
      return
    }

    if (action === "reject") {
      const cleared = clearPendingApproval(chatId)
      if (cleared) {
        scheduleAttachmentCleanup(cleared.attachments.map((attachment) => attachment.path))
      }
      await answerCallbackQuerySafe(bot as any, query.id, "已拒绝执行")
      await editMessageTextSafe(bot as any, chatId, messageId, "❌ 这次 Codex 执行已被拒绝。", {
        parse_mode: "HTML",
      })
      return
    }

    if (action === "always") {
      executionApprovalModeMap.set(chatId, "auto")
      saveExecutionApprovalModes()
    }

    clearPendingApproval(chatId)
    await answerCallbackQuerySafe(bot as any, query.id, action === "always" ? "已设为总是允许，并开始执行" : "已批准，开始执行")
    await editMessageTextSafe(
      bot as any,
      chatId,
      messageId,
      action === "always" ? "✅ 已设为总是允许，Codex 正在执行。" : "✅ 已批准，Codex 正在执行。",
      {
        parse_mode: "HTML",
      },
    )
    void (async () => {
      try {
        await handlePrompt(chatId, approval.userText, approval.attachments)
      } finally {
        scheduleAttachmentCleanup(approval.attachments.map((attachment) => attachment.path))
      }
    })()
    return
  }

  if (data.startsWith("codex-model:")) {
    const model = data.slice("codex-model:".length)
    if (model === "__default__") {
      selectedModelMap.delete(chatId)
    } else {
      selectedModelMap.set(chatId, model)
    }
    saveSelectedModels()

    const effectiveModel = getEffectiveModel(chatId)
    await answerCallbackQuerySafe(bot as any, query.id, model === "__default__" ? "已恢复默认模型" : `已切换为 ${effectiveModel}`)
    await sendEffortPicker(chatId, effectiveModel, { messageId })
    return
  }

  if (data.startsWith("codex-workspace:")) {
    const target = data.slice("codex-workspace:".length)
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

  if (data.startsWith("codex-session:")) {
    const sessionId = data.slice("codex-session:".length)
    const record = getSessionRecord(chatId, sessionId)
    if (!sessionId || !record) {
      await answerCallbackQuerySafe(bot as any, query.id, "这条会话记录已经失效。")
      return
    }

    activateSession(chatId, sessionId)
    await answerCallbackQuerySafe(bot as any, query.id, "已切换到该会话")
    const nextMessage = buildWorkspaceHistoryMessage(chatId)
    await editMessageTextSafe(bot as any, chatId, messageId, nextMessage.text, nextMessage.options)
    return
  }

  const effort = data.slice("codex-effort:".length)
  if (effort === "__default__") {
    selectedReasoningEffortMap.delete(chatId)
  } else {
    selectedReasoningEffortMap.set(chatId, effort)
  }
  saveSelectedReasoningEfforts()

  await answerCallbackQuerySafe(
    bot as any,
    query.id,
    effort === "__default__" ? "已恢复默认推理强度" : `已切换为 ${effort}`,
  )
  await sendEffortPicker(chatId, getEffectiveModel(chatId), { messageId })
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
      await bot.sendMessage(normalized.chatId, `⚠️ 附件处理失败：${error.message}`).catch(() => { })
      return
    }
    throw error
  }

  try {
    await sendAttachmentPreview(normalized.chatId, resolvedAttachments)

    if (getExecutionApprovalSetting(normalized.chatId) === "prompt") {
      await requestExecutionApproval(normalized.chatId, normalized.bodyText, resolvedAttachments)
      resolvedAttachments = []
      return
    }

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
          titleHtml: "⚠️ <b>Codex 处理失败</b>",
          rawMessage: error instanceof Error ? error.message : String(error),
        }), {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        }).catch(() => { })
      })
    })
    return
  }

  await runProcessor([msg]).catch(async (error) => {
    await bot.sendMessage(msg.chat.id, buildSessionErrorNotice({
      titleHtml: "⚠️ <b>Codex 处理失败</b>",
      rawMessage: error instanceof Error ? error.message : String(error),
    }), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }).catch(() => { })
  })
})

bot.on("polling_error", (error: any) => {
  const message = String(error?.message || error || "")
  if (/\b409\b/.test(message) || /terminated by other getUpdates/i.test(message)) {
    console.error("❌ Telegram polling 冲突：同一个 Bot Token 正被另一个实例占用。")
    return
  }

  console.error("❌ Telegram polling error:", error)
})

console.log("🤖 Codex Telegram bot 已启动，等待消息…")
