import TelegramBot from "node-telegram-bot-api"
import { config } from "dotenv"
import * as fs from "fs"
import * as path from "path"
import { sendSessionCommand, sendSessionPromptAsync } from "./src/opencode/client"
import { buildSelectableProviders, loadLocalProviderState } from "./src/opencode/model-catalog"
import { buildCommandFileParts, buildPromptParts } from "./src/opencode/parts"
import { normalizeTelegramMessages, parseCommandText, shouldUseMediaGroupBuffer } from "./src/telegram/inbound"
import {
  cleanupExpiredMediaCache,
  DEFAULT_MEDIA_CACHE_TTL_MS,
  resolveTelegramAttachments,
  scheduleAttachmentCleanup,
  startMediaCacheJanitor,
  TelegramMediaError,
  getMediaCacheRoot,
} from "./src/telegram/media"
import { TelegramMediaGroupBuffer } from "./src/telegram/media-group-buffer"
import type { NormalizedInboundMessage, TelegramMessageLike, ResolvedTelegramAttachment } from "./src/telegram/types"

config()

const token = process.env.TELEGRAM_BOT_TOKEN
const allowedUserId = process.env.ALLOWED_USER_ID || "ALL"
const opencodeUrl = process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096"

if (!token || !allowedUserId) {
  console.error("❌ 错误：请在 .env 文件中设置 TELEGRAM_BOT_TOKEN 和 ALLOWED_USER_ID。")
  process.exit(1)
}

const bot = new TelegramBot(token, { polling: true })
const TG_API = `https://api.telegram.org/bot${token}`

// ─── 临时 ID 映射（规避 TG callback_data 64字节限制）─────────────────────────
const callbackPayloadMap = new Map<string, { type: string; value: string }>()
const permRequestMap = new Map<string, { sessionId: string; permId: string }>()
let callbackTokenCount = 0

function createCallbackToken(type: string, value: string): string {
  const token = `${type}:${(callbackTokenCount++).toString(36)}`
  callbackPayloadMap.set(token, { type, value })
  return token
}

// ─── Session 持久化 ────────────────────────────────────────────────────────────
const SESSIONS_FILE = path.join(process.cwd(), "sessions-map.json")
const SELECTED_MODELS_FILE = path.join(process.cwd(), "selected-models.json")
const sessionMap = new Map<number, string>()
const selectedModelMap = new Map<number, string>()

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"))
      for (const key of Object.keys(parsed)) sessionMap.set(Number(key), parsed[key])
      console.log(`📂 已从本地加载了 ${sessionMap.size} 个历史会话记录。`)
    }
  } catch (err) { console.error("加载会话记录失败:", err) }
}

function saveSessions() {
  try {
    const obj: Record<string, string> = {}
    for (const [key, value] of Array.from(sessionMap.entries())) obj[String(key)] = value
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2), "utf-8")
  } catch (err) { console.error("保存会话记录失败:", err) }
}

function loadSelectedModels() {
  try {
    if (fs.existsSync(SELECTED_MODELS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SELECTED_MODELS_FILE, "utf-8"))
      for (const key of Object.keys(parsed)) {
        if (typeof parsed[key] === "string" && parsed[key].includes("/")) {
          selectedModelMap.set(Number(key), parsed[key])
        }
      }
      console.log(`🤖 已从本地加载了 ${selectedModelMap.size} 个模型选择记录。`)
    }
  } catch (err) { console.error("加载模型选择记录失败:", err) }
}

function saveSelectedModels() {
  try {
    const obj: Record<string, string> = {}
    for (const [key, value] of Array.from(selectedModelMap.entries())) obj[String(key)] = value
    fs.writeFileSync(SELECTED_MODELS_FILE, JSON.stringify(obj, null, 2), "utf-8")
  } catch (err) { console.error("保存模型选择记录失败:", err) }
}

// ─── 辅助 API 函数 ─────────────────────────────────────────────────────────────
async function opencodeGet(path: string): Promise<any> {
  const res = await fetch(`${opencodeUrl}${path}`)
  return res.json()
}

async function opencodePost(path: string, body?: any): Promise<any> {
  const res = await fetch(`${opencodeUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

async function opencodeDelete(path: string): Promise<any> {
  const res = await fetch(`${opencodeUrl}${path}`, { method: "DELETE" })
  return res.json()
}

async function opencodePatch(path: string, body: any): Promise<any> {
  const res = await fetch(`${opencodeUrl}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return res.json()
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
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) return undefined
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  }
}

async function getModelMenuContext(chatId: number): Promise<{ providers: any[]; currentModel: string }> {
  const [providerData, cfgData, projectData] = await Promise.all([
    opencodeGet("/config/providers"),
    opencodeGet("/config").catch(() => null),
    opencodeGet("/project/current").catch(() => null),
  ])

  const projectDir =
    typeof projectData?.worktree === "string"
      ? projectData.worktree
      : typeof projectData?.path === "string"
        ? projectData.path
        : undefined

  const providers = buildSelectableProviders({
    serverProviders: getServerProviders(providerData),
    state: loadLocalProviderState({ projectDir }),
  })

  return {
    providers,
    currentModel: selectedModelMap.get(chatId) || cfgData?.model || "",
  }
}

loadSessions()
loadSelectedModels()

const mediaCacheRoot = getMediaCacheRoot(process.cwd())
void cleanupExpiredMediaCache(mediaCacheRoot, DEFAULT_MEDIA_CACHE_TTL_MS)
startMediaCacheJanitor({ rootDir: mediaCacheRoot, ttlMs: DEFAULT_MEDIA_CACHE_TTL_MS })
const mediaGroupBuffer = new TelegramMediaGroupBuffer<TelegramMessageLike>(350)

console.log("🚀 OpenCode Telegram Bridge (Enhanced Streaming) 运行中...")

// 注册所有 Telegram Bot 命令
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
  { command: "sessions", description: "💬 查看并切换历史会话" },
  { command: "commands", description: "📋 查看所有可用的自定义命令" },
])

// ─── sendMessageDraft ──────────────────────────────────────────────────────────
async function sendDraft(chatId: number, draftId: number, text: string) {
  // 如果文本为空，发送零宽空字符（或者一个空格）来迫使客户端清理输入框的草稿残影
  const payloadText = text === "" ? " " : text;

  try {
    const res = await fetch(`${TG_API}/sendMessageDraft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, draft_id: draftId, text: payloadText }),
    })
    if (!res.ok) {
      const body = await res.text()
      if (!body.includes("429")) console.log(`[Draft API ERROR] ${res.status} ${body}`)
    }
  } catch (e) { /* 静默 */ }
}

// ─── Markdown → Telegram HTML ──────────────────────────────────────────────────
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function markdownToTelegramHtml(md: string): string {
  const slots: string[] = []
  const placeholder = (html: string) => {
    slots.push(html)
    return `\x00${slots.length - 1}\x00`
  }
  let result = md
  result = result.replace(/```([\w\-+#.]*)?\n?([^`][\s\S]*?)```/g, (_m, lang, code) => {
    const escaped = escapeHtml(code.trim())
    const langAttr = lang ? ` class="language-${lang}"` : ""
    return placeholder(`<pre><code${langAttr}>${escaped}</code></pre>`)
  })
  result = result.replace(/`([^`\n]+)`/g, (_m, code) => placeholder(`<code>${escapeHtml(code)}</code>`))
  result = result.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  result = result.replace(/\*\*\*(.+?)\*\*\*/gs, "<b><i>$1</i></b>")
  result = result.replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>")
  result = result.replace(/\*([^\n*]+?)\*/g, "<i>$1</i>")
  result = result.replace(/__([^\n_]+?)__/g, "<u>$1</u>")
  result = result.replace(/_([^\n_]+?)_/g, "<i>$1</i>")
  result = result.replace(/~~(.+?)~~/gs, "<s>$1</s>")
  result = result.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>")
  result = result.replace(/\x00(\d+)\x00/g, (_m, i) => slots[Number(i)] ?? "")
  if (result.length > 4000) result = result.substring(0, 4000) + "…"
  return result
}

// ─── 气泡渲染体系 ──────────────────────────────────────────────────────────────
class Bubble {
  readonly id: string
  partType: string
  readonly draftId: number
  text: string = ""
  done: boolean = false
  lastDraftText: string = ""

  constructor(id: string, partType: string) {
    this.id = id
    this.partType = partType
    this.draftId = Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 100000) + 1
  }
}

interface ChatState {
  bubbles: Map<string, Bubble>
  bubbleOrder: string[]
  processing: boolean
  typingTimer: ReturnType<typeof setInterval> | null
}

const chatStates = new Map<number, ChatState>()
const pendingUserTexts = new Map<string, string>()

function getChatState(chatId: number): ChatState {
  if (!chatStates.has(chatId)) {
    chatStates.set(chatId, {
      bubbles: new Map(),
      bubbleOrder: [],
      processing: false,
      typingTimer: null
    })
  }
  return chatStates.get(chatId)!
}

function resetChatStreamState(chatId: number) {
  const state = getChatState(chatId)
  state.bubbleOrder = []
  state.bubbles.clear()
  return state
}

function stopTypingIndicator(chatId: number) {
  const state = getChatState(chatId)
  if (state.typingTimer) {
    clearInterval(state.typingTimer)
    state.typingTimer = null
  }
}

async function startTypingIndicator(chatId: number) {
  stopTypingIndicator(chatId)
  const state = getChatState(chatId)
  await bot.sendChatAction(chatId, "typing").catch(() => { })
  state.typingTimer = setInterval(async () => {
    await bot.sendChatAction(chatId, "typing").catch(() => { })
  }, 4000)
}

function resolveSelectedModel(chatId: number) {
  const selectedModel = selectedModelMap.get(chatId)
  return selectedModel ? parseModelRef(selectedModel) : undefined
}

async function resolveEffectiveModelInfo(chatId: number) {
  const [providerData, cfgData] = await Promise.all([
    opencodeGet("/config/providers").catch(() => null),
    opencodeGet("/config").catch(() => null),
  ])

  const effectiveModel = selectedModelMap.get(chatId) || cfgData?.model || ""
  const modelRef = parseModelRef(effectiveModel)
  if (!modelRef) return undefined

  const provider = getServerProviders(providerData).find((item) => item.id === modelRef.providerID)
  return provider?.models?.[modelRef.modelID]
}

function formatUserFacingError(error: unknown) {
  if (error instanceof TelegramMediaError) return error.message
  if (error instanceof Error) return error.message
  return "未知错误"
}

function buildMediaCacheKey(normalized: NormalizedInboundMessage) {
  const unique = normalized.mediaGroupId || normalized.messageIds.join("-")
  return `${normalized.chatId}-${unique}`
}

async function resolveInboundAttachments(normalized: NormalizedInboundMessage) {
  if (!normalized.attachments.length) return []
  return resolveTelegramAttachments({
    token: token!,
    attachments: normalized.attachments,
    cacheRoot: mediaCacheRoot,
    cacheKey: buildMediaCacheKey(normalized),
    getFile: async (fileId) => bot.getFile(fileId) as any,
  })
}

async function dispatchPromptMessage(chatId: number, normalized: NormalizedInboundMessage) {
  const sessionId = await ensureSession(chatId)
  resetChatStreamState(chatId)
  await startTypingIndicator(chatId)

  let attachments: ResolvedTelegramAttachment[] = []
  try {
    attachments = await resolveInboundAttachments(normalized)
    const modelInfo = attachments.length > 0 ? await resolveEffectiveModelInfo(chatId) : undefined
    const parts = buildPromptParts({ bodyText: normalized.bodyText, attachments, model: modelInfo })
    const userEchoText = parts.find((part) => part.type === "text")?.text
    if (userEchoText) pendingUserTexts.set(sessionId, userEchoText)

    await sendSessionPromptAsync({
      baseUrl: opencodeUrl,
      sessionId,
      model: resolveSelectedModel(chatId),
      parts,
    })

    scheduleAttachmentCleanup(attachments.map((item) => item.path))
  } catch (error) {
    scheduleAttachmentCleanup(attachments.map((item) => item.path), 1000)
    throw error
  }
}

async function dispatchCustomCommand(chatId: number, normalized: NormalizedInboundMessage, command: string, args: string) {
  const sessionId = await ensureSession(chatId)
  resetChatStreamState(chatId)
  await startTypingIndicator(chatId)

  let attachments: ResolvedTelegramAttachment[] = []
  try {
    attachments = await resolveInboundAttachments(normalized)
    await sendSessionCommand({
      baseUrl: opencodeUrl,
      sessionId,
      model: resolveSelectedModel(chatId),
      command,
      arguments: args,
      parts: attachments.length ? buildCommandFileParts(attachments) : undefined,
    })

    scheduleAttachmentCleanup(attachments.map((item) => item.path))
  } catch (error) {
    scheduleAttachmentCleanup(attachments.map((item) => item.path), 1000)
    throw error
  }
}

const partTypeHeaders: Record<string, string> = {
  reasoning: "🤔 <b>思考过程</b>",
  text: "💬 <b>回答</b>",
}

function extractSessionErrorMessage(payload: any) {
  const candidates = [
    payload?.properties?.error?.data?.message,
    payload?.properties?.error?.message,
    payload?.properties?.error?.data?.error,
    payload?.properties?.message,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim()
  }

  const fallback = payload?.properties?.error
  if (typeof fallback === "string" && fallback.trim()) return fallback.trim()

  return undefined
}

function buildSessionErrorNotice(rawMessage?: string) {
  const details = rawMessage?.trim()
  const lines = ["⚠️ <b>处理失败</b>"]

  if (details) {
    lines.push(`<code>${escapeHtml(details).slice(0, 3000)}</code>`)
  } else {
    lines.push("OpenCode 没有返回更具体的错误信息。")
  }

  if (details?.includes("AI_UnsupportedFunctionalityError") && details.includes("file part media type")) {
    lines.push("当前会话里已经混入了模型不支持的旧文件附件，请先发送 /new 新建会话后再试。")
  }

  return lines.join("\n\n")
}

// ─── Worker 串行渲染器 ────────────────────────────────────────────────────────
async function triggerWorker(chatId: number) {
  const state = getChatState(chatId)
  if (state.processing) return
  state.processing = true

  try {
    while (state.bubbleOrder.length > 0) {
      const bubbleId = state.bubbleOrder[0]
      const bubble = state.bubbles.get(bubbleId)!
      console.log(`[BUBBLE] 渲染气泡 id=${bubbleId} partType="${bubble.partType}" textLen=${bubble.text.length}`)
      let lastDraftTime = 0
      const startWait = Date.now()
      const MAX_WAIT = 3000 // 最多等待 3 秒

      while (!bubble.done) {
        const now = Date.now()
        // 超时保护：如果等待超过 30 秒且文本仍然为空，自动跳过
        if (now - startWait > MAX_WAIT && bubble.text.trim() === "") {
          console.log(`[BUBBLE] 超时跳过空气泡 id=${bubbleId}`)
          break
        }
        // 如果已有文本且超过 30 秒，强制标记完成
        if (now - startWait > MAX_WAIT) {
          console.log(`[BUBBLE] 超时强制完成 id=${bubbleId}`)
          bubble.done = true
          break
        }
        if (bubble.text !== bubble.lastDraftText && (now - lastDraftTime > 250)) {
          bubble.lastDraftText = bubble.text
          lastDraftTime = now
          const prefix = bubble.partType === "reasoning" ? "🤔 思考中...\n\n" : ""
          sendDraft(chatId, bubble.draftId, prefix + bubble.text).catch(() => { })
        }
        await new Promise(r => setTimeout(r, 50))
      }

      if (bubble.text !== bubble.lastDraftText && bubble.text.trim()) {
        const prefix = bubble.partType === "reasoning" ? "🤔 思考中...\n\n" : ""
        await sendDraft(chatId, bubble.draftId, prefix + bubble.text).catch(() => { })
      }

      const text = bubble.text.trim()
      if (text) {
        if (state.typingTimer) { clearInterval(state.typingTimer); state.typingTimer = null }

        let finalHtml: string
        if (bubble.partType === "reasoning") {
          const bodyHtml = markdownToTelegramHtml(text)
          finalHtml = `🤔 <b>思考过程</b>\n<blockquote expandable>${bodyHtml}</blockquote>`
        } else {
          const header = partTypeHeaders[bubble.partType] || ""
          const bodyHtml = markdownToTelegramHtml(text)
          finalHtml = header ? `${header}\n${bodyHtml}` : bodyHtml
        }

        let sentMsg: any = null
        await bot.sendMessage(chatId, finalHtml, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        } as any)
          .then(res => { sentMsg = res })
          .catch(async (e: any) => {
            if (e.message?.includes("can't parse entities")) {
              const header = partTypeHeaders[bubble.partType] || ""
              const plain = header ? `${header}\n${text}` : text
              await bot.sendMessage(chatId, plain).then(res => { sentMsg = res }).catch(() => { })
            }
          })

        // 发送空字符串清理输入框的回复草稿残影
        await sendDraft(chatId, bubble.draftId, "").catch(() => { })

        // 如果该气泡是思考过程，设定一分钟后自动删除
        if (bubble.partType === "reasoning" && sentMsg && sentMsg.message_id) {
          setTimeout(() => {
            bot.deleteMessage(chatId, sentMsg.message_id).catch(() => { })
          }, 60000)
        }
      }

      state.bubbleOrder.shift()
      state.bubbles.delete(bubbleId)
    }
  } finally {
    state.processing = false
  }
}

// ─── SSE 全局事件监听 ──────────────────────────────────────────────────────────
async function listenEvents() {
  const processedPartIds = new Set<string>()
  const partTypeMap = new Map<string, string>()
  const partSessionMap = new Map<string, string>()
  const lastToolDraftTime = new Map<number, number>()
  // delta 缓冲：在气泡创建前先积攒 delta 内容
  const deltaBuf = new Map<string, string>()

  while (true) {
    try {
      const res = await fetch(`${opencodeUrl}/event`)
      if (!res.body) throw new Error("No response body in /event")
      console.log("🟢 SSE 流连接成功")

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const chunks = buffer.split("\n\n")
        buffer = chunks.pop() || ""

        for (const chunk of chunks) {
          if (!chunk.startsWith("data: ")) continue
          try {
            let parsed = JSON.parse(chunk.slice(6))
            if (!parsed) continue

            // 如果 SSE 数据有外层包装 {directory, payload: {type, properties}}，则解包
            const payload = parsed.payload?.type ? parsed.payload : parsed

            // 打印未知事件类型（调试用）
            if (payload.type && !["message.part.updated", "message.part.delta", "server.connected", "server.heartbeat", "message.updated"].includes(payload.type)) {
              console.log(`[SSE-EVENT] type="${payload.type}" keys=${JSON.stringify(Object.keys(payload.properties || {}))}`)
            }

            // ── 权限审批事件 ─────────────────────────────────────────────────
            if (payload.type === "permission.asked") {
              const perm = payload.properties
              const permSessionId = perm?.sessionID
              if (!permSessionId) continue

              console.log(`[PERMISSION] 收到权限请求 id=${perm?.id} session=${permSessionId} permission=${perm?.permission}`)

              let permChatId = 0
              for (const [cId, sId] of Array.from(sessionMap.entries())) {
                if (sId === permSessionId) { permChatId = cId; break }
              }
              if (!permChatId) continue

              const permId = perm?.id
              const permType = perm?.permission || "未知权限"
              const patterns = perm?.patterns?.join(", ") || ""
              const toolInfo = perm?.tool ? `${perm.tool.callID || ""}` : ""
              const metadata = perm?.metadata || {}
              const filepath = metadata?.filepath || metadata?.command || ""

              const msgText = `⚠️ <b>权限审批请求</b>\n\n` +
                `🔒 <b>权限：</b><code>${escapeHtml(permType)}</code>\n` +
                (filepath ? `📄 <b>路径：</b><code>${escapeHtml(String(filepath)).substring(0, 300)}</code>\n` : "") +
                (patterns ? `📂 <b>匹配：</b><code>${escapeHtml(patterns).substring(0, 200)}</code>\n` : "") +
                `\n请选择处理方式：`

              const reqToken = createCallbackToken("perm", permId)
              permRequestMap.set(reqToken, { sessionId: permSessionId, permId })

              bot.sendMessage(permChatId, msgText, {
                parse_mode: "HTML",
                reply_markup: {
                  inline_keyboard: [[
                    { text: "✅ 允许一次", callback_data: `prm:once:${reqToken}` },
                    { text: "✅✅ 总是允许", callback_data: `prm:always:${reqToken}` },
                    { text: "❌ 拒绝", callback_data: `prm:reject:${reqToken}` },
                  ]]
                }
              } as any).catch((e: any) => {
                console.error("[PERM_SEND_ERROR]", e.message)
              })
              continue
            }

            // ── 提取 sessionID ────────────────────────────────────────────────
            let sessionID = payload.properties?.sessionID
              || payload.properties?.part?.sessionID
              || payload.properties?.info?.id

            if (!sessionID && payload.type === "message.part.delta") {
              const pId = payload.properties?.partID
              if (pId) sessionID = partSessionMap.get(pId)
            }

            if (!sessionID) continue

            let targetChatId = 0
            for (const [cId, sId] of Array.from(sessionMap.entries())) {
              if (sId === sessionID) { targetChatId = cId; break }
            }
            if (!targetChatId) continue

            const state = getChatState(targetChatId)

            if (payload.type === "session.error") {
              const errorMessage = extractSessionErrorMessage(payload)
              pendingUserTexts.delete(sessionID)
              stopTypingIndicator(targetChatId)
              sendDraft(targetChatId, 9999, "").catch(() => { })
              for (const bubble of state.bubbles.values()) bubble.done = true
              await bot.sendMessage(targetChatId, buildSessionErrorNotice(errorMessage), {
                parse_mode: "HTML",
                link_preview_options: { is_disabled: true },
              } as any).catch(() => { })
              continue
            }

            if (payload.type === "session.idle") {
              pendingUserTexts.delete(sessionID)
              stopTypingIndicator(targetChatId)
              sendDraft(targetChatId, 9999, "").catch(() => { })
              continue
            }

            // ── 消息部分更新 ──────────────────────────────────────────────────
            if (payload.type === "message.part.updated") {
              const part = payload.properties.part
              if (!part || !part.id) continue
              partSessionMap.set(part.id, sessionID)
              if (processedPartIds.has(part.id)) continue

              if (part.type === "text" || part.type === "reasoning") {
                // 记录此 part 的真实类型（reasoning 或 text）
                partTypeMap.set(part.id, part.type)

                const userText = pendingUserTexts.get(sessionID)
                if (part.type === "text" && userText !== undefined && part.text === userText) continue

                // 取内容：reasoning 类型优先用 part.reasoning，否则用 part.text
                const content = (part.type === "reasoning" ? (part.reasoning || part.text) : part.text) || ""
                const hasContent = content && typeof content === "string" && content.trim() !== ""

                // 只在有实际内容时才创建气泡（避免空 reasoning 堵塞队列）
                // 优先使用 updated 里的内容，其次 flush 积攒的 delta 缓冲
                const buffered = deltaBuf.get(part.id) || ""
                const finalContent = hasContent ? content : (buffered.trim() ? buffered : "")

                if (finalContent) {
                  if (!state.bubbles.has(part.id)) {
                    console.log(`[SSE-UPDATED] 创建气泡 key=${part.id} partType="${part.type}" len=${finalContent.length}`)
                    const b = new Bubble(part.id, part.type)
                    state.bubbles.set(part.id, b)
                    state.bubbleOrder.push(part.id)
                    triggerWorker(targetChatId)
                  }
                  const bubble = state.bubbles.get(part.id)!
                  if (part.type === "reasoning" && bubble.partType !== "reasoning") {
                    bubble.partType = part.type
                  }
                  // updated 里有完整内容就用它，否则用 delta 缓冲
                  bubble.text = hasContent ? content : (bubble.text || buffered)
                  deltaBuf.delete(part.id)
                }

                // 结束标记：如果气泡存在则标记完成，否则直接标记已处理
                if (part.time?.end) {
                  processedPartIds.add(part.id)
                  pendingUserTexts.delete(sessionID)
                  if (state.bubbles.has(part.id)) {
                    state.bubbles.get(part.id)!.done = true
                  }
                }
              }

              if (part.type === "tool") {
                const toolName = part.tool || "unknown"
                const now = Date.now()
                const lastTime = lastToolDraftTime.get(targetChatId) || 0
                if (part.state?.status === "running" && now - lastTime > 2000) {
                  lastToolDraftTime.set(targetChatId, now)
                  sendDraft(targetChatId, 9999, `⚙️ 正在执行: ${toolName}…`).catch(() => { })
                }
              }
            }
            // ── 增量字符处理 ──────────────────────────────────────────────────
            else if (payload.type === "message.part.delta") {
              const props = payload.properties
              if ((props.field === "text" || props.field === "reasoning") && props.partID) {
                pendingUserTexts.delete(sessionID)
                if (processedPartIds.has(props.partID)) continue

                if (state.bubbles.has(props.partID)) {
                  // 气泡已存在，直接追加
                  state.bubbles.get(props.partID)!.text += props.delta
                } else {
                  // 气泡尚未创建，先缓冲（等 message.part.updated 来再 flush）
                  const cur = deltaBuf.get(props.partID) || ""
                  deltaBuf.set(props.partID, cur + props.delta)
                }
              }
            }
          } catch (e) { }
        }
      }
    } catch (err) {
      console.error("SSE 异常，2秒后重连", err)
      await new Promise(r => setTimeout(r, 2000))
    }
  }
}

listenEvents()

// ─── 权限审批 callback_query 处理 ─────────────────────────────────────────────
bot.on("callback_query", async (query: any) => {
  const data: string = query.data || ""
  const chatId: number = query.message?.chat?.id
  const messageId: number = query.message?.message_id

  // 权限审批按钮
  if (data.startsWith("prm:")) {
    const parts = data.split(":")
    const response = parts[1] // once | always | reject
    const reqToken = parts.slice(2).join(":")
    const reqInfo = permRequestMap.get(reqToken)

    if (!reqInfo) {
      bot.answerCallbackQuery(query.id, { text: "❌ 审批请求已过期" }).catch(() => { })
      return
    }

    const { sessionId, permId } = reqInfo

    try {
      await fetch(`${opencodeUrl}/permission/${permId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply: response }),
      })

      const label = response === "once" ? "✅ 已允许（本次）"
        : response === "always" ? "✅ 已允许（总是）"
          : "❌ 已拒绝"

      await bot.editMessageText(query.message.text + `\n\n${label}`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] }
      } as any).catch(() => { })
    } catch (e) {
      await bot.answerCallbackQuery(query.id, { text: "❌ 操作失败" }).catch(() => { })
    }
    await bot.answerCallbackQuery(query.id).catch(() => { })
    return
  }

  // 会话切换按钮
  if (data.startsWith("s:")) {
    const payload = callbackPayloadMap.get(data)
    const newSessionId = payload?.type === "session" ? payload.value : undefined
    if (!newSessionId) {
      bot.answerCallbackQuery(query.id, { text: "❌ 会话信息已过期，请重新获取" }).catch(() => { })
      return
    }
    sessionMap.set(chatId, newSessionId)
    chatStates.delete(chatId)
    saveSessions()
    bot.editMessageText(`✅ 已切换到会话 <code>${newSessionId}</code>`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] }
    } as any).catch(() => { })
    bot.answerCallbackQuery(query.id).catch(() => { })
    return
  }

  // 供应商返回按钮 (从模型列表返回)
  if (data === "p:back") {
    try {
      const { providers, currentModel } = await getModelMenuContext(chatId)

      const keyboard: any[][] = []
      let totalProviders = 0
      let currentRow: any[] = []

      for (const provider of providers) {
        if (!provider.models || Object.keys(provider.models).length === 0) continue
        if (totalProviders >= 50) break

        const label = getProviderDisplayName(provider)
        currentRow.push({ text: label, callback_data: createCallbackToken("provider", provider.id) })
        totalProviders++
        if (currentRow.length === 2) {
          keyboard.push(currentRow)
          currentRow = []
        }
      }
      if (currentRow.length > 0) keyboard.push(currentRow)

      const header = `🤖 <b>选择模型供应商</b>${currentModel ? `\n(当前使用: <code>${escapeHtml(currentModel)}</code>)` : ""}:`
      bot.editMessageText(header, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard }
      } as any).catch(() => { })
    } catch (e) {
      bot.answerCallbackQuery(query.id, { text: "❌ 获取列表失败" }).catch(() => { })
    }
    bot.answerCallbackQuery(query.id).catch(() => { })
    return
  }

  // 点击供应商，拉取该供应商下的模型列表
  if (data.startsWith("provider:")) {
    const payload = callbackPayloadMap.get(data)
    const providerId = payload?.type === "provider" ? payload.value : undefined
    if (!providerId) {
      bot.answerCallbackQuery(query.id, { text: "❌ 供应商信息已过期，请重新获取" }).catch(() => { })
      return
    }
    try {
      const { providers, currentModel } = await getModelMenuContext(chatId)
      const provider = providers.find(p => p.id === providerId)

      if (!provider || !provider.models) {
        bot.answerCallbackQuery(query.id, { text: "❌ 该供应商下无模型" }).catch(() => { })
        return
      }

      const keyboard: any[][] = []
      const modelsObj: Record<string, any> = provider.models
      const configuredModelKeys = Object.keys(modelsObj)
      let totalModels = 0

      for (const modelKey of configuredModelKeys) {
        if (totalModels >= 80) break // limit to avoid massive keyboards
        const fullId = `${provider.id}/${modelKey}`
        const modelInfo = modelsObj[modelKey] || {}
        const displayName = (modelInfo as any)?.name || modelKey
        const isCurrent = currentModel === fullId || currentModel.endsWith(`/${modelKey}`)
        const label = `${isCurrent ? "✅ " : ""}${displayName}`

        // 1 个模型占一整行，防止名字太长被截断
        keyboard.push([{ text: label, callback_data: createCallbackToken("model", fullId) }])
        totalModels++
      }

      keyboard.push([{ text: "🔙 返回供应商列表", callback_data: "p:back" }])

      const header = `🤖 <b>选择 ${escapeHtml(getProviderDisplayName(provider))} 的模型</b>${currentModel ? `\n(当前: <code>${escapeHtml(currentModel)}</code>)` : ""}:`
      bot.editMessageText(header, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard }
      } as any).catch(() => { })
    } catch (e) {
      bot.answerCallbackQuery(query.id, { text: "❌ 获取模型失败" }).catch(() => { })
    }
    bot.answerCallbackQuery(query.id).catch(() => { })
    return
  }

  // 模型切换按钮
  if (data.startsWith("model:")) {
    const payload = callbackPayloadMap.get(data)
    const modelId = payload?.type === "model" ? payload.value : undefined
    if (!modelId) {
      bot.answerCallbackQuery(query.id, { text: "❌ 模型信息已过期，请重新获取" }).catch(() => { })
      return
    }
    try {
      selectedModelMap.set(chatId, modelId)
      saveSelectedModels()
      bot.editMessageText(`✅ 已切换到模型 <code>${escapeHtml(modelId)}</code>`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] }
      } as any).catch(() => { })
    } catch (e) {
      bot.answerCallbackQuery(query.id, { text: "❌ 切换模型失败" }).catch(() => { })
    }
    bot.answerCallbackQuery(query.id).catch(() => { })
    return
  }

  // 自定义命令执行按钮
  if (data.startsWith("command:")) {
    const payload = callbackPayloadMap.get(data)
    const cmdName = payload?.type === "command" ? payload.value : undefined
    const sessionId = sessionMap.get(chatId)
    if (!cmdName || !sessionId) {
      await bot.answerCallbackQuery(query.id, { text: "❌ 当前无会话" })
      return
    }
    try {
      const selectedModel = selectedModelMap.get(chatId)
      await opencodePost(`/session/${sessionId}/command`, {
        model: selectedModel ? parseModelRef(selectedModel) : undefined,
        command: `/${cmdName}`,
        arguments: ""
      })
      await bot.editMessageText(`✅ 已执行命令 <code>/${cmdName}</code>`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] }
      } as any).catch(() => { })
    } catch (e) {
      await bot.answerCallbackQuery(query.id, { text: "❌ 命令执行失败" })
    }
    await bot.answerCallbackQuery(query.id)
    return
  }

  await bot.answerCallbackQuery(query.id)
})

// ─── 辅助: 确保当前有会话，若无则创建 ─────────────────────────────────────────
async function ensureSession(chatId: number): Promise<string> {
  let sessionId = sessionMap.get(chatId)
  if (!sessionId) {
    const data = await opencodePost("/session", { title: `Telegram Chat ${chatId}` })
    sessionId = data.id
    sessionMap.set(chatId, sessionId!)
    saveSessions()
    console.log(`✅ 为聊天 ${chatId} 创建并持久化了新会话：${sessionId}`)
  }
  return sessionId!
}

// ─── 辅助: 执行内置 slash 命令 ────────────────────────────────────────────────
async function runBuiltinCommand(chatId: number, command: string, args?: string) {
  const sessionId = await ensureSession(chatId)
  const selectedModel = selectedModelMap.get(chatId)
  return opencodePost(`/session/${sessionId}/command`, {
    model: selectedModel ? parseModelRef(selectedModel) : undefined,
    command,
    arguments: args || ""
  })
}

async function processTelegramMessages(messages: TelegramMessageLike[]) {
  const normalized = normalizeTelegramMessages(messages)
  if (!normalized) return

  const chatId = normalized.chatId
  const commandInput = parseCommandText(normalized.bodyText)
  const cmd = commandInput?.cmd ?? ""
  const args = commandInput?.args ?? ""

  // ── /new ──────────────────────────────────────────────────────────────────
  if (cmd === "/new") {
    if (sessionMap.has(chatId)) {
      chatStates.delete(chatId)
      sessionMap.delete(chatId)
      saveSessions()
      await bot.sendMessage(chatId, "♻️ 对话上下文已重置。")
    } else {
      await bot.sendMessage(chatId, "📝 当前没有进行中的会话。")
    }
    return
  }

  // ── /stop ────────────────────────────────────────────────────────────────
  if (cmd === "/stop") {
    const sessionId = sessionMap.get(chatId)
    if (!sessionId) { await bot.sendMessage(chatId, "📭 没有进行中的会话。"); return }
    const state = getChatState(chatId)
    stopTypingIndicator(chatId)

    // 清除目前所有可能存在的草稿（发送零宽空格清理）
    for (const bubble of state.bubbles.values()) {
      sendDraft(chatId, bubble.draftId, " ").catch(() => { })
    }
    // 强制发送一个兜底的常用Draft ID清理（或者依靠上述循环）
    sendDraft(chatId, 9999, " ").catch(() => { })

    state.bubbleOrder = []
    state.bubbles.clear()
    state.processing = false
    try {
      await fetch(`${opencodeUrl}/session/${sessionId}/abort`, { method: "POST" })
      await bot.sendMessage(chatId, "⛔ 已中止当前响应。")
    } catch (e) {
      await bot.sendMessage(chatId, "⚠️ 中止请求发送失败。")
    }
    return
  }

  // ── /plan ────────────────────────────────────────────────────────────────
  if (cmd === "/plan") {
    const sessionId = sessionMap.get(chatId)
    if (!sessionId) { await bot.sendMessage(chatId, "📭 请先发送消息建立会话，再切换模式。"); return }
    try {
      await runBuiltinCommand(chatId, "/mode", "plan")
      await bot.sendMessage(chatId, "🗺️ 已切换到 <b>Plan</b> 模式。\n只分析代码，不修改文件。\n使用 /build 切回默认模式。", { parse_mode: "HTML" })
    } catch (e) {
      await bot.sendMessage(chatId, "⚠️ 模式切换失败，请确认当前有活跃会话。")
    }
    return
  }

  // ── /build ───────────────────────────────────────────────────────────────
  if (cmd === "/build") {
    const sessionId = sessionMap.get(chatId)
    if (!sessionId) { await bot.sendMessage(chatId, "📭 请先发送消息建立会话，再切换模式。"); return }
    try {
      await runBuiltinCommand(chatId, "/mode", "build")
      await bot.sendMessage(chatId, "🔨 已切换到 <b>Build</b> 模式（默认，全工具开放）。", { parse_mode: "HTML" })
    } catch (e) {
      await bot.sendMessage(chatId, "⚠️ 模式切换失败。")
    }
    return
  }

  // ── /undo ────────────────────────────────────────────────────────────────
  if (cmd === "/undo") {
    const sessionId = sessionMap.get(chatId)
    if (!sessionId) { await bot.sendMessage(chatId, "📭 没有进行中的会话。"); return }
    try {
      await runBuiltinCommand(chatId, "/undo")
      await bot.sendMessage(chatId, "↩️ 已撤销上一次操作。")
    } catch (e) {
      await bot.sendMessage(chatId, "⚠️ 撤销失败。")
    }
    return
  }

  // ── /redo ────────────────────────────────────────────────────────────────
  if (cmd === "/redo") {
    const sessionId = sessionMap.get(chatId)
    if (!sessionId) { await bot.sendMessage(chatId, "📭 没有进行中的会话。"); return }
    try {
      await runBuiltinCommand(chatId, "/redo")
      await bot.sendMessage(chatId, "↪️ 已重做操作。")
    } catch (e) {
      await bot.sendMessage(chatId, "⚠️ 重做失败。")
    }
    return
  }

  // ── /share ───────────────────────────────────────────────────────────────
  if (cmd === "/share") {
    const sessionId = sessionMap.get(chatId)
    if (!sessionId) { await bot.sendMessage(chatId, "📭 没有进行中的会话。"); return }
    try {
      const result = await opencodePost(`/session/${sessionId}/share`)
      const shareUrl = result?.share?.url || result?.url || result?.id
      if (shareUrl) {
        const url = shareUrl.startsWith("http") ? shareUrl : `https://opncd.ai/s/${shareUrl}`
        await bot.sendMessage(chatId, `🔗 <b>会话已分享！</b>\n\n${url}`, { parse_mode: "HTML" })
      } else {
        await bot.sendMessage(chatId, `⚠️ 分享成功但未获取到 URL。\n<code>${JSON.stringify(result)}</code>`, { parse_mode: "HTML" })
      }
    } catch (e) {
      await bot.sendMessage(chatId, "⚠️ 分享失败。请检查 OpenCode 配置是否启用了分享功能。")
    }
    return
  }

  // ── /unshare ─────────────────────────────────────────────────────────────
  if (cmd === "/unshare") {
    const sessionId = sessionMap.get(chatId)
    if (!sessionId) { await bot.sendMessage(chatId, "📭 没有进行中的会话。"); return }
    try {
      await opencodeDelete(`/session/${sessionId}/share`)
      await bot.sendMessage(chatId, "🔒 已取消会话分享。")
    } catch (e) {
      await bot.sendMessage(chatId, "⚠️ 取消分享失败。")
    }
    return
  }

  // ── /name ──────────────────────────────────────────────────────────────
  if (cmd === "/name") {
    const sessionId = sessionMap.get(chatId)
    if (!sessionId) { await bot.sendMessage(chatId, "📭 没有进行中的会话。"); return }
    if (!args) { await bot.sendMessage(chatId, "📝 用法：<code>/name 你的会话名称</code>", { parse_mode: "HTML" }); return }
    try {
      await fetch(`${opencodeUrl}/session/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: args }),
      })
      await bot.sendMessage(chatId, `✅ 会话已重命名为：<b>${escapeHtml(args)}</b>`, { parse_mode: "HTML" })
    } catch (e) {
      await bot.sendMessage(chatId, "⚠️ 重命名失败。")
    }
    return
  }

  // ── /status ──────────────────────────────────────────────────────────────
  if (cmd === "/status") {
    const sessionId = sessionMap.get(chatId)
    try {
      const [cfgData, projData, sessionDetail, messages] = await Promise.all([
        opencodeGet("/config").catch(() => null),
        opencodeGet("/project/current").catch(() => null),
        sessionId ? opencodeGet(`/session/${sessionId}`).catch(() => null) : null,
        sessionId ? opencodeGet(`/session/${sessionId}/message`).catch(() => null) : null,
      ])
      const model = selectedModelMap.get(chatId) || cfgData?.model || "未知"
      const project = projData?.path || projData?.name || "未知"
      const sessionTitle = sessionDetail?.title || "未命名"

      // 计算上下文长度：累计所有 assistant 消息的 token
      let totalTokens = 0, totalInput = 0, totalOutput = 0, totalReasoning = 0, cacheRead = 0, cacheWrite = 0
      let lastTokens: any = null
      if (Array.isArray(messages)) {
        for (const msg of messages) {
          const t = msg?.info?.tokens
          if (t && msg?.info?.role === "assistant") {
            totalTokens += (t.total || 0)
            totalInput += (t.input || 0)
            totalOutput += (t.output || 0)
            totalReasoning += (t.reasoning || 0)
            cacheRead += (t.cache?.read || 0)
            cacheWrite += (t.cache?.write || 0)
            lastTokens = t
          }
        }
      }

      const msgCount = Array.isArray(messages) ? messages.length : 0

      let lines = [
        `📊 <b>OpenCode 状态</b>`,
        ``,
        `🤖 <b>模型：</b><code>${escapeHtml(model)}</code>`,
        `📁 <b>项目：</b><code>${escapeHtml(project)}</code>`,
        `💬 <b>会话：</b><code>${escapeHtml(sessionTitle)}</code>`,
        `🔑 <b>ID：</b><code>${sessionId || "无"}</code>`,
        `💌 <b>消息数：</b>${msgCount}`,
      ]

      const toK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`

      if (totalTokens > 0) {
        lines.push(``)
        lines.push(`📏 <b>上下文用量（累计）</b>`)
        lines.push(`├ 总 Token：<code>${toK(totalTokens)}</code>`)
        lines.push(`├ 输入：<code>${toK(totalInput)}</code>`)
        lines.push(`├ 输出：<code>${toK(totalOutput)}</code>`)
        lines.push(`├ 推理：<code>${toK(totalReasoning)}</code>`)
        if (cacheRead > 0 || cacheWrite > 0) {
          lines.push(`├ 缓存读：<code>${toK(cacheRead)}</code>`)
          lines.push(`└ 缓存写：<code>${toK(cacheWrite)}</code>`)
        } else {
          lines.push(`└ 缓存：<code>无</code>`)
        }
      }

      if (lastTokens) {
        lines.push(``)
        lines.push(`📎 <b>最近一轮</b>`)
        lines.push(`├ Token：<code>${toK(lastTokens.total || 0)}</code>`)
        lines.push(`├ 输入：<code>${toK(lastTokens.input || 0)}</code>`)
        lines.push(`└ 输出：<code>${toK(lastTokens.output || 0)}</code>`)
      }

      lines.push(``)
      lines.push(`💡 使用 <code>/name 名称</code> 可自定义会话标题`)

      await bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" })
    } catch (e) {
      const lines = [`📊 <b>快速状态</b>`, `💬 <b>会话 ID：</b><code>${sessionId || "无"}</code>`]
      await bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" })
    }
    return
  }

  // ── /models ────────────────────────────────────────────────────────────────────────────
  if (cmd === "/models") {
    try {
      const { providers, currentModel } = await getModelMenuContext(chatId)
      if (!providers.length) { await bot.sendMessage(chatId, "📭 未找到已配置的模型供应商。"); return }

      const keyboard: any[][] = []
      let totalProviders = 0
      let currentRow: any[] = []

      for (const provider of providers) {
        if (!provider.models || Object.keys(provider.models).length === 0) continue
        if (totalProviders >= 50) break // TG Inline keyboard 行数限制

        const label = getProviderDisplayName(provider)
        currentRow.push({ text: label, callback_data: createCallbackToken("provider", provider.id) })
        totalProviders++

        // 每行 2 个按钮
        if (currentRow.length === 2) {
          keyboard.push(currentRow)
          currentRow = []
        }
      }
      if (currentRow.length > 0) keyboard.push(currentRow)

      const header = `🤖 <b>选择模型供应商</b>${currentModel ? `\n(当前使用: <code>${escapeHtml(currentModel)}</code>)` : ""}:`
      await bot.sendMessage(chatId, header, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard }
      } as any)
    } catch (e: any) {
      console.error("[/models ERROR]", e.message)
      await bot.sendMessage(chatId, "⚠️ 获取模型供应商列表失败。")
    }
    return
  }

  // ── /sessions ────────────────────────────────────────────────────────────
  if (cmd === "/sessions") {
    try {
      const sessions: any[] = await opencodeGet("/session")
      if (!sessions.length) { await bot.sendMessage(chatId, "📭 没有历史会话。"); return }

      const currentSession = sessionMap.get(chatId)
      const keyboard: any[][] = []
      sessions.slice(0, 10).forEach((s) => {
        const isActive = s.id === currentSession
        const label = `${isActive ? "✅ " : ""}${(s.title || s.id).substring(0, 35)}`
        keyboard.push([{ text: label, callback_data: createCallbackToken("session", s.id) }])
      })

      await bot.sendMessage(chatId, "💬 <b>选择会话：</b>（✅ 为当前活跃会话）", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard }
      } as any)
    } catch (e) {
      await bot.sendMessage(chatId, "⚠️ 获取会话列表失败。")
    }
    return
  }

  // ── /commands ────────────────────────────────────────────────────────────
  if (cmd === "/commands") {
    try {
      const cmds: any[] = await opencodeGet("/command")
      if (!cmds.length) { await bot.sendMessage(chatId, "📭 没有可用的自定义命令。"); return }

      const keyboard: any[][] = []
      for (const c of cmds.slice(0, 20)) {
        const name = c.name || c.id || "unknown"
        const desc = c.description || ""
        keyboard.push([{
          text: `/${name}${desc ? ` — ${desc}` : ""}`,
          callback_data: createCallbackToken("command", name)
        }])
      }

      await bot.sendMessage(chatId, "📋 <b>所有可用命令：</b>（点击执行）", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard }
      } as any)
    } catch (e) {
      await bot.sendMessage(chatId, "⚠️ 获取命令列表失败。")
    }
    return
  }

  // ── 其余 slash 命令 → 转发到 OpenCode 自定义命令 ───────────────────────
  if (commandInput) {
    try {
      await dispatchCustomCommand(chatId, normalized, cmd, args)
    } catch (error) {
      stopTypingIndicator(chatId)
      await bot.sendMessage(chatId, `⚠️ 错误: ${formatUserFacingError(error)}`)
    }
    return
  }

  // ── 普通文本 / 图片 / 文件 → 发送到 OpenCode ───────────────────────────
  try {
    await dispatchPromptMessage(chatId, normalized)
  } catch (error) {
    stopTypingIndicator(chatId)
    await bot.sendMessage(chatId, `⚠️ 错误: ${formatUserFacingError(error)}`)
  }
}

// ─── 接收用户消息 ──────────────────────────────────────────────────────────────
bot.on("message", async (rawMsg: any) => {
  const msg = rawMsg as TelegramMessageLike
  const chatId = msg.chat.id
  const userId = msg.from?.id

  if (allowedUserId !== "ALL" && String(userId) !== allowedUserId) {
    await bot.sendMessage(chatId, "🚫 未授权访客。")
    return
  }

  if (shouldUseMediaGroupBuffer(msg) && msg.media_group_id) {
    const bufferKey = `${chatId}:${msg.media_group_id}`
    mediaGroupBuffer.enqueue(bufferKey, msg, async (groupMessages) => {
      try {
        await processTelegramMessages(groupMessages)
      } catch (error) {
        stopTypingIndicator(chatId)
        await bot.sendMessage(chatId, `⚠️ 错误: ${formatUserFacingError(error)}`).catch(() => { })
      }
    })
    return
  }

  try {
    await processTelegramMessages([msg])
  } catch (error) {
    stopTypingIndicator(chatId)
    await bot.sendMessage(chatId, `⚠️ 错误: ${formatUserFacingError(error)}`)
  }
})

bot.on("polling_error", (error: any) => {
  console.log(`Polling Error: ${error.message}`)
})
