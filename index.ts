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

// ─── 初始化 bot ────────────────────────────────────────────────────────────────
const bot = new TelegramBot(token, { polling: true })

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

loadSessions()

/**
 * 验证持久化的 Session 是否仍然有效（OpenCode 可能已清理掉旧会话）
 * 利用 GET /session/{id} API 检查，无效则从 sessionMap 中移除
 */
async function validateSessions() {
  if (sessionMap.size === 0) return;
  let removed = 0;
  for (const [chatId, sessionId] of Array.from(sessionMap.entries())) {
    try {
      const res = await fetch(`${opencodeUrl}/session/${sessionId}`);
      if (!res.ok) {
        sessionMap.delete(chatId);
        removed++;
        console.log(`🗑️ 会话 ${sessionId}（Chat ${chatId}）已失效，已从缓存清除。`);
      }
    } catch (e) {
      // OpenCode 未启动时跳过验证
      break;
    }
  }
  if (removed > 0) saveSessions();
  console.log(`✅ 会话验证完成：${sessionMap.size} 个有效，${removed} 个已清除。`);
}

validateSessions().catch(() => { });

console.log("🚀 OpenCode Telegram Bridge (Enhanced) 运行中...")
if (allowedUserId === "ALL") {
  console.log("⚠️ 警告：演示模式，允许任何人访问。")
} else {
  console.log(`🔒 白名单已开启，仅允许 User ID: ${allowedUserId}`)
}

bot.setMyCommands([
  { command: "new", description: "重置当前对话，开启新会话 (Reset context)" },
  { command: "status", description: "查看当前会话状态和基本信息" }
])

// ─── Markdown → Telegram HTML 转换 (仿 OpenClaw format.ts) ──────────────────────
/**
 * 将 Markdown 安全地转为 Telegram 支持的 HTML，并处理流式不完整标签
 * 支持：**bold**, *italic*, `inline code`, ```code block```, > blockquote
 */
function markdownToTelegramHtml(md: string): string {
  const slots: string[] = []
  const placeholder = (html: string) => {
    slots.push(html)
    return `\x00${slots.length - 1}\x00`
  }

  let result = md

  // 1. 提取三重反引号代码块（含不完整的流式代码块）
  //    (?:[\w\-+#.]*) 匹配语言标识，可为空
  result = result.replace(/```([\w\-+#.]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const escaped = escapeHtml(code.trim())
    const langAttr = lang ? ` class="language-${lang}"` : ""
    return placeholder(`<pre><code${langAttr}>${escaped}</code></pre>`)
  })

  // 1b. 处理流式场景下只有开头 ``` 但还没有结束 ``` 的情况 —— 放入 placeholder 保护
  result = result.replace(/```[\w\-+#.]*\n?([\s\S]*)$/g, (_m, code) => {
    return placeholder(`<code>${escapeHtml(code)}</code>`)
  })

  // 2. 提取反引号内联代码
  result = result.replace(/`([^`\n]+)`/g, (_m, code) =>
    placeholder(`<code>${escapeHtml(code)}</code>`)
  )

  // 3. 转义剩余普通文本中的 HTML 特殊字符
  result = result
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")

  // 4. 行内格式（Bold / Italic / 删除线）
  result = result.replace(/\*\*\*(.+?)\*\*\*/gs, "<b><i>$1</i></b>")
  result = result.replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>")
  result = result.replace(/\*([^\n*]+?)\*/g, "<i>$1</i>")
  result = result.replace(/_([^\n_]+?)_/g, "<i>$1</i>")
  result = result.replace(/~~(.+?)~~/gs, "<s>$1</s>")

  // 5. Blockquote
  result = result.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>")

  // 6. 还原所有代码占位符
  result = result.replace(/\x00(\d+)\x00/g, (_m, i) => slots[Number(i)] ?? "")

  // 7. 截断（Telegram 上限 4096，留余量）
  if (result.length > 4000) result = result.substring(0, 4000) + "…"

  return result
}


function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// ─── 气泡（Bubble）：每个 partID 对应一条独立的 Telegram 消息气泡 ──────────────
class Bubble {
  readonly partType: string
  text: string = ""
  messageId: number = 0
  isTyping: boolean = false
  lastEditTime: number = 0
  done: boolean = false

  constructor(partType: string) {
    this.partType = partType
  }
}

interface ChatState {
  // 按 partID 独立管理每个气泡 — 零干扰、零竞争
  bubbles: Map<string, Bubble>
  // per-chat 串行消息队列
  messageQueue: Promise<void>
}

const partTypeHeaders: Record<string, string> = {
  reasoning: "🤔 <b>思考过程</b>",
  text: "💬 <b>回答</b>",
}

const chatStates = new Map<number, ChatState>()
const pendingUserTexts = new Map<string, string>()
// partTypeMap: partID → type（从 part.updated 获知），供 delta 创建 Bubble 时确定类型
const partTypeMap = new Map<string, string>()

function getChatState(chatId: number): ChatState {
  if (!chatStates.has(chatId)) {
    chatStates.set(chatId, {
      bubbles: new Map(),
      messageQueue: Promise.resolve(),
    })
  }
  return chatStates.get(chatId)!
}

function enqueueForChat<T>(chatId: number, state: ChatState, fn: () => Promise<T>): Promise<T> {
  const next = state.messageQueue.then(() => fn())
  state.messageQueue = next.then(() => { }, () => { })
  return next
}

// ─── SSE 全局事件监听 ──────────────────────────────────────────────────────────
async function listenEvents() {
  console.log("📡 开始后台监听 OpenCode 全局事件流...")
  const processedPartIds = new Set<string>()
  while (true) {
    try {
      const res = await fetch(`${opencodeUrl}/event`)
      if (!res.body) throw new Error("No response body in /event")
      const sseConnectedAt = Date.now()
      console.log(`🟢 SSE 已连接 (t=${sseConnectedAt})`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) { console.log("🔴 SSE 断开"); break }
        buffer += decoder.decode(value, { stream: true })
        const chunks = buffer.split("\n\n")
        buffer = chunks.pop() || ""

        for (const chunk of chunks) {
          if (!chunk.startsWith("data: ")) continue
          try {
            const payload = JSON.parse(chunk.slice(6))
            if (!payload) continue

            const sessionID = payload.properties?.sessionID
              || payload.properties?.part?.sessionID
              || payload.properties?.info?.id
            if (!sessionID) continue

            let targetChatId = 0
            for (const [cId, sId] of Array.from(sessionMap.entries())) {
              if (sId === sessionID) { targetChatId = cId; break }
            }
            if (!targetChatId) continue

            const state = getChatState(targetChatId)

            // ── message.part.updated ──────────────────────────────────────────
            if (payload.type === "message.part.updated") {
              const part = payload.properties.part
              if (!part || !part.id) continue

              // 跳过已处理
              if (processedPartIds.has(part.id)) continue

              // 记录 partID 类型，供 delta 创建 Bubble 时使用
              if (part.type === "text" || part.type === "reasoning") {
                partTypeMap.set(part.id, part.type)
              }

              // 跳过 SSE 重放的旧事件
              if (part.time?.end && part.time.end < sseConnectedAt) {
                processedPartIds.add(part.id)
                continue
              }

              // 过滤用户回显
              const userText = pendingUserTexts.get(sessionID)
              if (part.type === "text" && userText !== undefined && part.text === userText) continue

              if ((part.type === "text" || part.type === "reasoning") && part.time?.end) {
                // ── Part 完成（end=true）—— 最终快照 ──────────────────────
                processedPartIds.add(part.id)
                pendingUserTexts.delete(sessionID)

                let bubble = state.bubbles.get(part.id)
                if (!bubble) {
                  // 没有通过 delta 创建过 — 用快照创建
                  bubble = new Bubble(part.type)
                  state.bubbles.set(part.id, bubble)
                }
                if (bubble.done) continue

                if (part.text && typeof part.text === "string") {
                  bubble.text = part.text
                }
                // 如果还没发送过，先 flush 一次
                if (!bubble.isTyping) {
                  await enqueueForChat(targetChatId, state, () => flushBubble(targetChatId, bubble!))
                }
                await enqueueForChat(targetChatId, state, () => finalizeBubble(targetChatId, bubble!))
              }

              // 工具调用状态
              if (part.type === "tool") {
                const toolName = part.tool || "unknown"
                const statusMsg = part.state?.status === "running"
                  ? `⚙️ 正在执行: \`${toolName}\`…`
                  : part.state?.status === "completed"
                    ? `✅ 完成: \`${toolName}\``
                    : null
                if (statusMsg) {
                  let bubble = state.bubbles.get(part.id)
                  if (!bubble) {
                    bubble = new Bubble("tool")
                    state.bubbles.set(part.id, bubble)
                  }
                  const b = bubble
                  await enqueueForChat(targetChatId, state, async () => {
                    if (!b.isTyping) {
                      b.isTyping = true
                      const m = await bot.sendMessage(targetChatId, statusMsg, { parse_mode: "HTML" }).catch(() => null)
                      if (m) b.messageId = m.message_id
                    } else if (b.messageId) {
                      await bot.editMessageText(statusMsg, {
                        chat_id: targetChatId, message_id: b.messageId, parse_mode: "HTML"
                      }).catch(() => { })
                    }
                  })
                }
              }
            }

            // ── message.part.delta ────────────────────────────────────────────
            else if (payload.type === "message.part.delta") {
              const props = payload.properties
              if (props.field === "text" && props.partID) {
                pendingUserTexts.delete(sessionID)
                if (processedPartIds.has(props.partID)) continue

                let bubble = state.bubbles.get(props.partID)
                if (!bubble) {
                  // 从 partTypeMap 或 props.type 确定类型
                  const partType = partTypeMap.get(props.partID) || (props.type === "reasoning" ? "reasoning" : "text")
                  bubble = new Bubble(partType)
                  state.bubbles.set(props.partID, bubble)
                }
                if (bubble.done) continue

                bubble.text += props.delta
                await enqueueForChat(targetChatId, state, () => flushBubble(targetChatId, bubble!))
              }
            }
          } catch (e) { /* 忽略解析错误 */ }
        }
      }
    } catch (err) {
      console.error("SSE 连接错误，2s 后重连:", err)
      await new Promise(r => setTimeout(r, 2000))
    }
  }
}

/**
 * 节流推送 Bubble 内容到 Telegram
 */
async function flushBubble(chatId: number, bubble: Bubble) {
  if (bubble.done || !bubble.text) return
  const now = Date.now()
  if (!bubble.isTyping) {
    bubble.isTyping = true
    const m = await bot.sendMessage(chatId, bubble.text).catch(e => {
      console.error("[TG] sendMessage error:", e.message); return null
    })
    if (m) bubble.messageId = m.message_id
    bubble.lastEditTime = now
  } else if (now - bubble.lastEditTime > 20 && bubble.messageId) {
    bubble.lastEditTime = now
    const htmlText = markdownToTelegramHtml(bubble.text)
    await bot.editMessageText(htmlText, {
      chat_id: chatId, message_id: bubble.messageId, parse_mode: "HTML"
    }).catch((e) => {
      if (e.message?.includes("can't parse entities")) {
        return bot.editMessageText(bubble.text, {
          chat_id: chatId, message_id: bubble.messageId,
        }).catch(() => { })
      }
    })
  }
}

/**
 * 收尾 Bubble：加标题、如果是 reasoning 则 1 分钟后删除
 */
async function finalizeBubble(chatId: number, bubble: Bubble) {
  if (bubble.done) return
  bubble.done = true
  const text = bubble.text.trim()
  const header = partTypeHeaders[bubble.partType] || ""
  if (text && bubble.messageId) {
    const bodyHtml = markdownToTelegramHtml(text)
    const finalHtml = header ? `${header}\n${bodyHtml}` : bodyHtml
    await bot.editMessageText(finalHtml, {
      chat_id: chatId, message_id: bubble.messageId, parse_mode: "HTML"
    }).catch((e) => {
      if (e.message?.includes("can't parse entities")) {
        const plain = header ? `${header}\n${text}` : text
        return bot.editMessageText(plain, {
          chat_id: chatId, message_id: bubble.messageId,
        }).catch(() => { })
      }
    })
  }
  if (bubble.partType === "reasoning" && bubble.messageId) {
    const msgId = bubble.messageId
    setTimeout(async () => {
      await bot.deleteMessage(chatId, msgId).catch(() => { })
      console.log(`[💨 BURN] 思考消息已自动消除 (chat=${chatId})`)
    }, 60 * 1000)
  }
  console.log(`[DONE] bubble(${bubble.partType}) chat=${chatId}`)
}

// 启动全局 SSE 监听
listenEvents()

// ─── Telegram 消息处理 ────────────────────────────────────────────────────────
bot.on("message", async (msg: any) => {
  const chatId = msg.chat.id
  const userId = msg.from?.id
  const text = msg.text

  // 权限校验
  if (allowedUserId !== "ALL" && String(userId) !== allowedUserId) {
    console.warn(`⚠️ 拦截未授权访问：User ID ${userId}`)
    await bot.sendMessage(chatId, "🚫 你没有权限访问这个大模型代理。")
    return
  }

  if (!text) return

  // /new 命令：重置会话上下文
  if (text.trim() === "/new") {
    if (sessionMap.has(chatId)) {
      sessionMap.delete(chatId)
      saveSessions()
      console.log(`♻️ 重置了聊天 ${chatId} 的会话上下文。`)
      await bot.sendMessage(chatId, "♻️ 你的对话上下文已重置。发送消息以开启全新的一轮对话。")
    } else {
      await bot.sendMessage(chatId, "📝 当前没有进行中的会话，发送消息即可开始对话。")
    }
    return
  }

  // /status 命令：查看当前会话状态
  if (text.trim() === "/status") {
    const sessionId = sessionMap.get(chatId)
    if (!sessionId) {
      await bot.sendMessage(chatId, "📭 当前没有活跃的会话，发送任意消息即可创建新会话。")
      return
    }
    try {
      const [sessRes, msgRes] = await Promise.all([
        fetch(`${opencodeUrl}/session/${sessionId}`),
        fetch(`${opencodeUrl}/session/${sessionId}/message`)
      ])
      const sess = sessRes.ok ? (await sessRes.json()) as any : null
      const msgs = msgRes.ok ? (await msgRes.json()) as any : null
      const title = sess?.title || "Telegram Chat"
      const messageCount = Array.isArray(msgs) ? msgs.length : "?"
      const created = sess?.time?.created ? new Date(sess.time.created).toLocaleString("zh-CN") : "未知"
      await bot.sendMessage(chatId,
        `📊 <b>当前会话状态</b>\n` +
        `🏷 标题：${title}\n` +
        `🆔 Session ID：<code>${sessionId.slice(0, 16)}…</code>\n` +
        `💬 消息数：${messageCount} 条\n` +
        `📅 创建时间：${created}\n\n` +
        `发送 /new 可重置会话上下文。`,
        { parse_mode: "HTML" }
      )
    } catch (e) {
      await bot.sendMessage(chatId, `⚠️ 获取会话信息失败，请确认 OpenCode 服务正在运行。`)
    }
    return
  }

  try {
    // 获取或创建 Session ID
    let sessionId = sessionMap.get(chatId)
    if (!sessionId) {
      const initRes = await fetch(`${opencodeUrl}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `Telegram Chat ${chatId}` }),
      })
      if (!initRes.ok) throw new Error("无法初始化会话")
      const data = (await initRes.json()) as any
      sessionId = data.id
      sessionMap.set(chatId, sessionId!)
      saveSessions()
      console.log(`✅ 为聊天 ${chatId} 创建并持久化了新会话：${sessionId}`)
    }

    const currentSessionId = sessionId!

    // 记录用户发送的文本，用于 SSE 事件处理时过滤回显
    pendingUserTexts.set(currentSessionId, text)
    // 发送消息给 OpenCode（异步，不等待结果）
    fetch(`${opencodeUrl}/session/${currentSessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: text }] }),
    }).catch(e => console.error("[TG] 发送消息失败:", e))

    await bot.sendChatAction(chatId, "typing")

  } catch (error: any) {
    console.error("执行命令出错:", error)
    await bot.sendMessage(chatId, `⚠️ 执行期间出错: ${error.message}`)
  }
})

bot.on("polling_error", (error: any) => {
  console.log(`Telegram Polling Error: ${error.message}`)
})
