type ToolEntry = {
  name: string
  status: "running" | "done" | "failed"
  summary?: string
}

export class ToolStatusTracker {
  private readonly entries: ToolEntry[] = []

  constructor(private readonly maxEntries = 12) {}

  addToolUse(name: string) {
    this.entries.push({ name, status: "running" })
    if (this.entries.length > this.maxEntries) {
      this.entries.shift()
    }
  }

  addToolProgress(name?: string, summary?: string) {
    const target = name ? [...this.entries].reverse().find((entry) => entry.name === name) : this.entries.at(-1)
    if (!target) return
    if (summary?.trim()) {
      target.summary = summary.trim()
    }
  }

  markToolResult(name?: string, status: "done" | "failed" = "done") {
    const target = name ? [...this.entries].reverse().find((entry) => entry.name === name) : this.entries.at(-1)
    if (!target) return
    target.status = status
  }

  renderPlain() {
    if (this.entries.length === 0) return ""

    const lines = ["🛠 工具执行状态", ""]
    for (const entry of this.entries) {
      const icon = entry.status === "running" ? "⏳" : entry.status === "done" ? "✅" : "❌"
      lines.push(entry.summary ? `${icon} ${entry.name} · ${entry.summary}` : `${icon} ${entry.name}`)
    }
    return lines.join("\n")
  }
}
