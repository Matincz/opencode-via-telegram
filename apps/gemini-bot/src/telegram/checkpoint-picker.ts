import type { StoredChatSnapshot } from "../store/snapshots"

function truncateValue(value: string, maxLength = 24) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

export function buildCheckpointPickerMessage(checkpoints: StoredChatSnapshot[]) {
  const visible = checkpoints.slice(-8).reverse()
  const lines = ["<b>Telegram Checkpoints</b>"]

  for (const checkpoint of visible) {
    lines.push(`<code>${checkpoint.id.slice(0, 8)}</code> ${truncateValue(checkpoint.title)}`)
  }

  lines.push("", "按钮：恢复 / 删除")

  return {
    text: lines.join("\n"),
    options: {
      parse_mode: "HTML" as const,
      reply_markup: {
        inline_keyboard: visible.map((checkpoint) => ([
          {
            text: `↺ ${truncateValue(checkpoint.title, 10)}`,
            callback_data: `checkpoint:restore:${checkpoint.id}`,
          },
          {
            text: "🗑 删除",
            callback_data: `checkpoint:delete:${checkpoint.id}`,
          },
        ])),
      },
    },
  }
}
