import { escapeHtml } from "./rendering"

export interface ToolStatusEntry {
  name: string
  status: "running" | "done" | "failed"
  timestamp: number
}

export class ToolStatusTracker {
  private entries: ToolStatusEntry[] = []
  private readonly maxEntries: number

  constructor(maxEntries = 12) {
    this.maxEntries = maxEntries
  }

  addToolUse(name: string) {
    this.entries.push({ name, status: "running", timestamp: Date.now() })
    if (this.entries.length > this.maxEntries) {
      this.entries.shift()
    }
  }

  completeToolResult(name: string, success: boolean) {
    const entry = [...this.entries].reverse().find(
      (e) => e.name === name && e.status === "running",
    )
    if (entry) {
      entry.status = success ? "done" : "failed"
    }
  }

  clear() {
    this.entries = []
  }

  listToolNames() {
    return [...new Set(this.entries.map((entry) => entry.name).filter(Boolean))]
  }

  get isEmpty() {
    return this.entries.length === 0
  }

  renderHtml() {
    if (this.entries.length === 0) return ""

    const lines = ["🛠 <b>工具执行状态</b>", ""]
    for (const entry of this.entries) {
      const icon = entry.status === "running" ? "⏳" : entry.status === "done" ? "✅" : "❌"
      lines.push(`${icon} <code>${escapeHtml(entry.name)}</code>`)
    }
    return lines.join("\n")
  }

  renderPlain() {
    if (this.entries.length === 0) return ""

    const lines = ["🛠 工具执行状态", ""]
    for (const entry of this.entries) {
      const icon = entry.status === "running" ? "⏳" : entry.status === "done" ? "✅" : "❌"
      lines.push(`${icon} ${entry.name}`)
    }
    return lines.join("\n")
  }
}

export function buildApprovalPromptMessage(input: {
  planText: string
  toolSummary: string[]
  token: string
  todoSummary?: string[]
}) {
  const lines = [
    "📋 <b>执行计划审批</b>",
    "",
    `<blockquote expandable>${escapeHtml(input.planText).slice(0, 3000)}</blockquote>`,
  ]

  if (input.todoSummary && input.todoSummary.length > 0) {
    lines.push("", "🗂 <b>计划步骤：</b>")
    for (const todo of input.todoSummary.slice(0, 8)) {
      lines.push(`• ${escapeHtml(todo)}`)
    }
  }

  if (input.toolSummary.length > 0) {
    lines.push("", "🛠 <b>预计使用的工具：</b>")
    for (const tool of input.toolSummary.slice(0, 8)) {
      lines.push(`• <code>${escapeHtml(tool)}</code>`)
    }
  }

  lines.push("", "请选择操作：")

  return {
    text: lines.join("\n"),
    options: {
      parse_mode: "HTML" as const,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ 允许一次", callback_data: `gplan:once:${input.token}` },
            { text: "✅✅ 总是允许", callback_data: `gplan:always:${input.token}` },
            { text: "❌ 拒绝", callback_data: `gplan:reject:${input.token}` },
          ],
          [
            { text: "✏️ 需要修改", callback_data: `gplan:revise:${input.token}` },
          ],
        ],
      },
    },
  }
}
