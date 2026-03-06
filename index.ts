import TelegramBot from "node-telegram-bot-api"
import { config } from "dotenv"
import * as fs from "fs"
import * as path from "path"

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
const modelIndexMap = new Map<number, string>()  // idx -> fullModelId
const sessionIndexMap = new Map<number, string>() // idx -> sessionId
const providerIndexMap = new Map<number, string>() // idx -> providerId
const permRequestMap = new Map<number, { sessionId: string; permId: string }>() // idx -> Request
let permRequestCount = 0

// ─── Session 持久化 ────────────────────────────────────────────────────────────
const SESSIONS_FILE = path.join(process.cwd(), "sessions-map.json")
const sessionMap = new Map<number, string>()

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

loadSessions()

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
  try {
    const res = await fetch(`${TG_API}/sendMessageDraft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, draft_id: draftId, text }),
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
  readonly partType: string
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

const partTypeHeaders: Record<string, string> = {
  reasoning: "🤔 <b>思考过程</b>",
  text: "💬 <b>回答</b>",
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
      let lastDraftTime = 0

      while (!bubble.done) {
        const now = Date.now()
        if (bubble.text !== bubble.lastDraftText && (now - lastDraftTime > 250)) {
          bubble.lastDraftText = bubble.text
          lastDraftTime = now
          const prefix = bubble.partType === "reasoning" ? "🤔 思考中...\n\n" : ""
          sendDraft(chatId, bubble.draftId, prefix + bubble.text).catch(() => { })
        }
        await new Promise(r => setTimeout(r, 50))
      }

      if (bubble.text !== bubble.lastDraftText) {
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

        await bot.sendMessage(chatId, finalHtml, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        } as any).catch(async (e: any) => {
          if (e.message?.includes("can't parse entities")) {
            const header = partTypeHeaders[bubble.partType] || ""
            const plain = header ? `${header}\n${text}` : text
            await bot.sendMessage(chatId, plain).catch(() => { })
          }
        })
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
            const payload = JSON.parse(chunk.slice(6))
            if (!payload) continue

            // ── 权限审批事件 ─────────────────────────────────────────────────
            if (payload.type === "session.permission") {
              const perm = payload.properties
              const permSessionId = perm?.sessionID || perm?.info?.sessionID
              if (!permSessionId) continue

              let permChatId = 0
              for (const [cId, sId] of Array.from(sessionMap.entries())) {
                if (sId === permSessionId) { permChatId = cId; break }
              }
              if (!permChatId) continue

              const permId = perm?.permissionID || perm?.id
              const toolName = perm?.tool || perm?.title || "未知操作"
              const details = perm?.input || perm?.description || ""

              const msgText = `⚠️ <b>权限审批请求</b>\n\n` +
                `🔧 <b>操作：</b><code>${escapeHtml(toolName)}</code>\n` +
                (details ? `📝 <b>详情：</b><code>${escapeHtml(String(details)).substring(0, 300)}</code>\n` : "") +
                `\n请选择处理方式：`

              const reqIdx = permRequestCount++
              permRequestMap.set(reqIdx, { sessionId: permSessionId, permId })

              bot.sendMessage(permChatId, msgText, {
                parse_mode: "HTML",
                reply_markup: {
                  inline_keyboard: [[
                    { text: "✅ 允许一次", callback_data: `prm:once:${reqIdx}` },
                    { text: "✅✅ 总是允许", callback_data: `prm:always:${reqIdx}` },
                    { text: "❌ 拒绝", callback_data: `prm:reject:${reqIdx}` },
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

            // ── 消息部分更新 ──────────────────────────────────────────────────
            if (payload.type === "message.part.updated") {
              const part = payload.properties.part
              if (!part || !part.id) continue
              partSessionMap.set(part.id, sessionID)
              if (processedPartIds.has(part.id)) continue

              if (part.type === "text" || part.type === "reasoning") {
                partTypeMap.set(part.id, part.type)

                const userText = pendingUserTexts.get(sessionID)
                if (part.type === "text" && userText !== undefined && part.text === userText) continue

                if (!state.bubbles.has(part.id)) {
                  const b = new Bubble(part.id, part.type)
                  state.bubbles.set(part.id, b)
                  state.bubbleOrder.push(part.id)
                  triggerWorker(targetChatId)
                }

                const bubble = state.bubbles.get(part.id)!
                if (part.text && typeof part.text === "string") bubble.text = part.text
                if (part.reasoning && typeof part.reasoning === "string") bubble.text = part.reasoning

                if (part.time?.end) {
                  processedPartIds.add(part.id)
                  pendingUserTexts.delete(sessionID)
                  bubble.done = true
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

                if (!state.bubbles.has(props.partID)) {
                  const partType = partTypeMap.get(props.partID) || (props.type === "reasoning" ? "reasoning" : "text")
                  const b = new Bubble(props.partID, partType)
                  state.bubbles.set(props.partID, b)
                  state.bubbleOrder.push(props.partID)
                  triggerWorker(targetChatId)
                }
                const bubble = state.bubbles.get(props.partID)!
                bubble.text += props.delta
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
    const reqIdx = parseInt(parts[2], 10)
    const reqInfo = permRequestMap.get(reqIdx)

    if (!reqInfo) {
      bot.answerCallbackQuery(query.id, { text: "❌ 审批请求已过期" }).catch(() => { })
      return
    }

    const { sessionId, permId } = reqInfo

    try {
      await fetch(`${opencodeUrl}/session/${sessionId}/permissions/${permId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response }),
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
    const idx = parseInt(data.replace("s:", ""), 10)
    const newSessionId = sessionIndexMap.get(idx)
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
      const providerData = await opencodeGet("/provider")
      const cfgData = await opencodeGet("/config").catch(() => null)

      let providers: any[] = providerData?.all || []
      const connectedIds: string[] = providerData?.connected || []
      providers = providers.filter(p => connectedIds.includes(p.id))

      const currentModel: string = cfgData?.model || ""

      providerIndexMap.clear()
      const keyboard: any[][] = []
      let totalProviders = 0
      let currentRow: any[] = []

      for (const provider of providers) {
        if (!provider.models || Object.keys(provider.models).length === 0) continue
        if (totalProviders >= 50) break

        const label = provider.name || provider.id
        currentRow.push({ text: label, callback_data: `p:${totalProviders}` })
        providerIndexMap.set(totalProviders, provider.id)
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
  if (data.startsWith("p:") && data !== "p:back") {
    const idx = parseInt(data.replace("p:", ""), 10)
    const providerId = providerIndexMap.get(idx)
    if (!providerId) {
      bot.answerCallbackQuery(query.id, { text: "❌ 供应商信息已过期，请重新获取" }).catch(() => { })
      return
    }
    try {
      const [providerData, cfgData] = await Promise.all([
        opencodeGet("/provider"),
        opencodeGet("/config").catch(() => null),
      ])
      let providers: any[] = providerData?.all || []
      const connectedIds: string[] = providerData?.connected || []
      providers = providers.filter(p => connectedIds.includes(p.id))
      const provider = providers.find(p => p.id === providerId)
      const currentModel: string = cfgData?.model || ""

      if (!provider || !provider.models) {
        bot.answerCallbackQuery(query.id, { text: "❌ 该供应商下无模型" }).catch(() => { })
        return
      }

      modelIndexMap.clear()
      const keyboard: any[][] = []
      const modelsObj: Record<string, any> = provider.models
      let totalModels = 0

      for (const [modelKey, modelInfo] of Object.entries(modelsObj)) {
        if (totalModels >= 80) break // limit to avoid massive keyboards
        const fullId = `${provider.id}/${modelKey}`
        const displayName = (modelInfo as any)?.name || modelKey
        const isCurrent = currentModel === fullId || currentModel.endsWith(`/${modelKey}`)
        const label = `${isCurrent ? "✅ " : ""}${displayName}`

        // 1 个模型占一整行，防止名字太长被截断
        keyboard.push([{ text: label, callback_data: `m:${totalModels}` }])
        modelIndexMap.set(totalModels, fullId)
        totalModels++
      }

      keyboard.push([{ text: "🔙 返回供应商列表", callback_data: "p:back" }])

      const header = `🤖 <b>选择 ${escapeHtml(provider.name || provider.id)} 的模型</b>${currentModel ? `\n(当前: <code>${escapeHtml(currentModel)}</code>)` : ""}:`
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
  if (data.startsWith("m:")) {
    const idx = parseInt(data.replace("m:", ""), 10)
    const modelId = modelIndexMap.get(idx)
    if (!modelId) {
      bot.answerCallbackQuery(query.id, { text: "❌ 模型信息已过期，请重新获取" }).catch(() => { })
      return
    }
    try {
      await opencodePatch("/config", { model: modelId })
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
  if (data.startsWith("cmd:run:")) {
    const cmdName = data.replace("cmd:run:", "")
    const sessionId = sessionMap.get(chatId)
    if (!sessionId) {
      await bot.answerCallbackQuery(query.id, { text: "❌ 当前无会话" })
      return
    }
    try {
      await opencodePost(`/session/${sessionId}/command`, { command: `/${cmdName}`, arguments: "" })
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
  return opencodePost(`/session/${sessionId}/command`, {
    command,
    arguments: args || ""
  })
}

// ─── 接收用户消息 ──────────────────────────────────────────────────────────────
bot.on("message", async (msg: any) => {
  const chatId = msg.chat.id
  const userId = msg.from?.id
  const text = msg.text

  if (allowedUserId !== "ALL" && String(userId) !== allowedUserId) {
    await bot.sendMessage(chatId, "🚫 未授权访客。")
    return
  }

  if (!text) return

  const cmd = text.trim().split(" ")[0].toLowerCase()
  const args = text.trim().slice(cmd.length).trim()

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
    if (state.typingTimer) { clearInterval(state.typingTimer); state.typingTimer = null }
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
      await opencodePost(`/session/${sessionId}/command`, { command: "/mode", arguments: "plan" })
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
      await opencodePost(`/session/${sessionId}/command`, { command: "/mode", arguments: "build" })
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
      await opencodePost(`/session/${sessionId}/command`, { command: "/undo", arguments: "" })
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
      await opencodePost(`/session/${sessionId}/command`, { command: "/redo", arguments: "" })
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

  // ── /status ──────────────────────────────────────────────────────────────
  if (cmd === "/status") {
    const sessionId = sessionMap.get(chatId)
    try {
      const [cfgData, projData] = await Promise.all([
        opencodeGet("/config").catch(() => null),
        opencodeGet("/project/current").catch(() => null),
      ])
      const model = cfgData?.model || "未知"
      const project = projData?.path || projData?.name || "未知"
      let lines = [
        `📊 <b>OpenCode 状态</b>`,
        ``,
        `🤖 <b>模型：</b><code>${escapeHtml(model)}</code>`,
        `📁 <b>项目：</b><code>${escapeHtml(project)}</code>`,
        `💬 <b>会话 ID：</b><code>${sessionId || "无"}</code>`,
      ]
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
      const providerData = await opencodeGet("/provider")
      const cfgData = await opencodeGet("/config").catch(() => null)

      let providers: any[] = providerData?.all || []
      const connectedIds: string[] = providerData?.connected || []
      providers = providers.filter(p => connectedIds.includes(p.id))

      const currentModel: string = cfgData?.model || ""
      if (!providers.length) { await bot.sendMessage(chatId, "📭 未找到已配置的模型供应商。"); return }

      providerIndexMap.clear()
      const keyboard: any[][] = []
      let totalProviders = 0
      let currentRow: any[] = []

      for (const provider of providers) {
        if (!provider.models || Object.keys(provider.models).length === 0) continue
        if (totalProviders >= 50) break // TG Inline keyboard 行数限制

        const label = provider.name || provider.id
        currentRow.push({ text: label, callback_data: `p:${totalProviders}` })
        providerIndexMap.set(totalProviders, provider.id)
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

      sessionIndexMap.clear()
      const currentSession = sessionMap.get(chatId)
      const keyboard: any[][] = []
      sessions.slice(0, 10).forEach((s, i) => {
        sessionIndexMap.set(i, s.id)
        const isActive = s.id === currentSession
        const label = `${isActive ? "✅ " : ""}${(s.title || s.id).substring(0, 35)}`
        keyboard.push([{ text: label, callback_data: `s:${i}` }])
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
          callback_data: `cmd:run:${name}`
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

  // ── 普通消息 → 发送到 OpenCode ─────────────────────────────────────────
  if (cmd.startsWith("/")) return // 忽略未知命令

  try {
    const sessionId = await ensureSession(chatId)
    const state = getChatState(chatId)
    state.bubbleOrder = []
    state.bubbles.clear()

    pendingUserTexts.set(sessionId, text)
    fetch(`${opencodeUrl}/session/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text }] }),
    }).catch(() => { })

    await bot.sendChatAction(chatId, "typing").catch(() => { })
    state.typingTimer = setInterval(async () => {
      await bot.sendChatAction(chatId, "typing").catch(() => { })
    }, 4000)

  } catch (error: any) {
    await bot.sendMessage(chatId, `⚠️ 错误: ${error.message}`)
  }
})

bot.on("polling_error", (error: any) => {
  console.log(`Polling Error: ${error.message}`)
})
