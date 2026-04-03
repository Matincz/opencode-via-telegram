import type { StoredChatSnapshot } from "../store/snapshots"

function truncateValue(value: string, maxLength = 24) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

export function buildRewindPickerMessage(snapshots: StoredChatSnapshot[]) {
  const visible = snapshots.slice(-8).reverse()
  const lines = ["<b>Rewind 快照</b>", "选择一个时间点恢复当前 Telegram 会话上下文："]

  for (const snapshot of visible) {
    lines.push(`<code>${snapshot.id.slice(0, 8)}</code> ${truncateValue(snapshot.title)}`)
  }

  return {
    text: lines.join("\n"),
    options: {
      parse_mode: "HTML" as const,
      reply_markup: {
        inline_keyboard: visible.map((snapshot) => ([
          {
            text: `↺ ${truncateValue(snapshot.title, 16)}`,
            callback_data: `rewind:restore:${snapshot.id}`,
          },
        ])),
      },
    },
  }
}
