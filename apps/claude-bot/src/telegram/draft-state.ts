import type { ClaudeStreamEvent } from "../claude/client"

export class ClaudeDraftState {
  private text = ""
  private readonly toolNames = new Set<string>()
  private readonly taskDescriptions = new Map<string, string>()

  applyEvent(event: ClaudeStreamEvent) {
    if ((event.type === "text_delta" || event.type === "message") && event.content?.trim()) {
      this.text = event.content.trim()
    }

    if (event.type === "tool_use" && event.toolName.trim()) {
      this.toolNames.add(event.toolName.trim())
    }

    if (event.type === "task_started" && event.description.trim()) {
      this.taskDescriptions.set(event.taskId, event.description.trim())
    }

    if (event.type === "task_progress" && event.summary?.trim()) {
      this.taskDescriptions.set(event.taskId, event.summary.trim())
    }

    if (event.type === "task_completed") {
      this.taskDescriptions.delete(event.taskId)
    }
  }

  render() {
    if (this.text) return this.text

    const sections: string[] = []

    if (this.toolNames.size > 0) {
      sections.push(`使用工具：${Array.from(this.toolNames).join(", ")}`)
    }

    if (this.taskDescriptions.size > 0) {
      sections.push(`子任务：${Array.from(this.taskDescriptions.values()).join(", ")}`)
    }

    return sections.join("\n\n")
  }
}
