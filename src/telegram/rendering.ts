import TelegramBot from "node-telegram-bot-api"

const PART_TYPE_HEADERS: Record<string, string> = {
  reasoning: "🤔 <b>思考过程</b>",
  text: "💬 <b>回答</b>",
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

export function createDraftSender(tgApiBase: string) {
  return async function sendDraft(chatId: number, draftId: number, text: string) {
    const payloadText = text.trim().length === 0 ? "\u200b" : text

    try {
      const res = await fetch(`${tgApiBase}/sendMessageDraft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, draft_id: draftId, text: payloadText }),
      })
      if (!res.ok) {
        const body = await res.text()
        if (!body.includes("429")) console.log(`[Draft API ERROR] ${res.status} ${body}`)
      }
    } catch {
      // Draft 是纯优化通道，失败不阻塞主流程。
    }
  }
}

export async function sendRenderedAssistantPart(
  bot: TelegramBot,
  chatId: number,
  partType: string,
  rawText: string,
) {
  const text = rawText.trim()
  if (!text) return

  const bodyHtml = markdownToTelegramHtml(text)
  const finalHtml =
    partType === "reasoning"
      ? `🤔 <b>思考过程</b>\n<blockquote expandable>${bodyHtml}</blockquote>`
      : PART_TYPE_HEADERS[partType]
        ? `${PART_TYPE_HEADERS[partType]}\n${bodyHtml}`
        : bodyHtml

  let sentMsg: any = null
  try {
    sentMsg = await bot.sendMessage(chatId, finalHtml, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    } as any)
  } catch (error: any) {
    const plain = PART_TYPE_HEADERS[partType] ? `${PART_TYPE_HEADERS[partType]}\n${text}` : text
    if (error?.message?.includes("can't parse entities")) {
      console.warn(`[TG_SEND_HTML_FALLBACK] chat=${chatId} partType=${partType} reason=${error.message}`)
    } else {
      console.error(`[TG_SEND_ASSISTANT_ERROR] chat=${chatId} partType=${partType} reason=${error?.message || error}`)
    }

    sentMsg = await bot.sendMessage(chatId, plain).catch((fallbackError: any) => {
      console.error(
        `[TG_SEND_ASSISTANT_FALLBACK_ERROR] chat=${chatId} partType=${partType} reason=${fallbackError?.message || fallbackError}`,
      )
      throw fallbackError
    })
  }

  if (partType === "reasoning" && sentMsg?.message_id) {
    setTimeout(() => {
      bot.deleteMessage(chatId, sentMsg.message_id).catch(() => { })
    }, 60000)
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

export function buildSessionErrorNotice(rawMessage?: string) {
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
