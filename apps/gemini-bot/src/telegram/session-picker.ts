import type { GeminiCliSessionInfo } from "../gemini/sessions"

function truncateSummary(value: string, maxLength = 28) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

export function buildSessionPickerMessage(sessions: GeminiCliSessionInfo[], currentSessionId?: string) {
  const visibleSessions = sessions.slice(-8).reverse()
  const lines = ["<b>Gemini 原生会话</b>"]

  for (const session of visibleSessions) {
    const currentMarker = session.sessionId === currentSessionId ? " <- 当前" : ""
    lines.push(`${session.index}. <code>${session.sessionId.slice(0, 8)}</code> ${truncateSummary(session.summary)}${currentMarker}`)
    lines.push(`   ${session.relativeTime}`)
  }

  lines.push("", "按钮：恢复 / 删除")

  const inlineKeyboard = visibleSessions.map((session) => ([
    {
      text: `↺ #${session.index}`,
      callback_data: `session:resume:${session.sessionId}`,
    },
    {
      text: `🗑 #${session.index}`,
      callback_data: `session:delete:${session.index}`,
    },
  ]))

  return {
    text: lines.join("\n"),
    options: {
      parse_mode: "HTML" as const,
      reply_markup: {
        inline_keyboard: inlineKeyboard,
      },
    },
  }
}
