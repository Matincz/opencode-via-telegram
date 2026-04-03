const DEFAULT_PART_TYPE_HEADERS: Record<string, string> = {
  reasoning: "🤔 <b>思考过程</b>",
  status: "🛠 <b>执行状态</b>",
  text: "💬 <b>回答</b>",
}

export type DraftEmptyTextBehavior = "skip" | "zero_width_space"

type TelegramRenderBot = {
  sendMessage: (chatId: number, text: string, options?: Record<string, any>) => Promise<any>
  deleteMessage: (chatId: number, messageId: number) => Promise<any>
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function markdownToTelegramHtml(md: string): string {
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

export function createDraftSender(input: {
  tgApiBase: string
  emptyTextBehavior?: DraftEmptyTextBehavior
}) {
  return async function sendDraft(chatId: number, draftId: number, text: string) {
    const trimmed = text.trim()
    if (trimmed.length === 0 && input.emptyTextBehavior === "skip") return

    const payloadText = trimmed.length === 0 && input.emptyTextBehavior === "zero_width_space" ? "\u200b" : text

    try {
      const res = await fetch(`${input.tgApiBase}/sendMessageDraft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, draft_id: draftId, text: payloadText }),
      })
      if (!res.ok) {
        const body = await res.text()
        if (trimmed.length === 0 && body.includes("text must be non-empty")) return
        if (!body.includes("429")) console.log(`[Draft API ERROR] ${res.status} ${body}`)
      }
    } catch {
      // Draft 是纯优化通道，失败不阻塞主流程。
    }
  }
}

function isTransientTelegramSendError(error: any) {
  const message = String(error?.message || error || "")
  return (
    /\b(429|500|502|503|504)\b/.test(message) ||
    /timed out|timeout|socket hang up|ECONNRESET|EAI_AGAIN|ENOTFOUND|EFATAL/i.test(message)
  )
}

async function sendTelegramMessageWithRetry(
  bot: TelegramRenderBot,
  chatId: number,
  text: string,
  options: Record<string, any> | undefined,
  meta: { partType: string; mode: "html" | "plain" },
) {
  let lastError: any = null

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await bot.sendMessage(chatId, text, options as any)
    } catch (error: any) {
      lastError = error
      if (!isTransientTelegramSendError(error) || attempt === 3) break
      console.warn(
        `[TG_SEND_RETRY] chat=${chatId} partType=${meta.partType} mode=${meta.mode} attempt=${attempt} reason=${error?.message || error}`,
      )
      await new Promise((resolve) => setTimeout(resolve, attempt * 500))
    }
  }

  throw lastError
}

export async function sendRenderedAssistantPart(
  bot: TelegramRenderBot,
  chatId: number,
  partType: string,
  rawText: string,
  options?: {
    partTypeHeaders?: Record<string, string>
    reasoningDeleteDelayMs?: number
  },
) {
  const text = rawText.trim()
  if (!text) return

  const partTypeHeaders = options?.partTypeHeaders ?? DEFAULT_PART_TYPE_HEADERS
  const bodyHtml = markdownToTelegramHtml(text)
  const usesExpandableBlock = partType === "reasoning" || partType === "status"
  const finalHtml =
    usesExpandableBlock && partTypeHeaders[partType]
      ? `${partTypeHeaders[partType]}\n<blockquote expandable>${bodyHtml}</blockquote>`
      : partTypeHeaders[partType]
        ? `${partTypeHeaders[partType]}\n${bodyHtml}`
        : bodyHtml

  let sentMsg: any = null
  try {
    sentMsg = await sendTelegramMessageWithRetry(bot, chatId, finalHtml, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }, {
      partType,
      mode: "html",
    })
  } catch (error: any) {
    const plain = partTypeHeaders[partType] ? `${partTypeHeaders[partType]}\n${text}` : text
    if (error?.message?.includes("can't parse entities")) {
      console.warn(`[TG_SEND_HTML_FALLBACK] chat=${chatId} partType=${partType} reason=${error.message}`)
    } else {
      console.error(`[TG_SEND_ASSISTANT_ERROR] chat=${chatId} partType=${partType} reason=${error?.message || error}`)
    }

    sentMsg = await sendTelegramMessageWithRetry(bot, chatId, plain, undefined, {
      partType,
      mode: "plain",
    }).catch((fallbackError: any) => {
      console.error(
        `[TG_SEND_ASSISTANT_FALLBACK_ERROR] chat=${chatId} partType=${partType} reason=${fallbackError?.message || fallbackError}`,
      )
      throw fallbackError
    })
  }

  if ((partType === "reasoning" || partType === "status") && sentMsg?.message_id) {
    setTimeout(() => {
      bot.deleteMessage(chatId, sentMsg.message_id).catch(() => {})
    }, options?.reasoningDeleteDelayMs ?? 60000)
  }
}

export function extractSessionErrorMessage(payload: any) {
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

export function buildSessionErrorNotice(input: {
  rawMessage?: string
  noDetailsText?: string
  titleHtml?: string
  unsupportedAttachmentHint?: string
}) {
  const details = input.rawMessage?.trim()
  const lines = [input.titleHtml ?? "⚠️ <b>处理失败</b>"]

  if (details) {
    lines.push(`<code>${escapeHtml(details).slice(0, 3000)}</code>`)
  } else {
    lines.push(input.noDetailsText ?? "当前后端没有返回更具体的错误信息。")
  }

  if (details?.includes("AI_UnsupportedFunctionalityError") && details.includes("file part media type")) {
    lines.push(input.unsupportedAttachmentHint ?? "当前会话里已经混入了模型不支持的旧文件附件，请先发送 /new 新建会话后再试。")
  }

  return lines.join("\n\n")
}
