export class ToolStatusTracker {
  private readonly entries: Array<{ name: string; status: "running" | "done" | "failed" }> = []

  constructor(private readonly maxEntries = 12) {}

  addToolUse(name: string) {
    this.entries.push({ name, status: "running" })
    if (this.entries.length > this.maxEntries) {
      this.entries.shift()
    }
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
