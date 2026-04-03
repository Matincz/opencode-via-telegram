import type { CodexStreamEvent } from "../codex/client"

export class CodexDraftState {
  private reasoning = ""
  private message = ""
  private readonly toolNames = new Set<string>()

  applyEvent(event: CodexStreamEvent) {
    if (event.type === "reasoning" && event.content?.trim()) {
      this.reasoning = event.content.trim()
    }

    if (event.type === "tool_use" && event.toolName?.trim()) {
      this.toolNames.add(event.toolName.trim())
    }

    if (event.type === "message" && event.content?.trim()) {
      this.message = event.content.trim()
    }
  }

  render() {
    if (this.message) return this.message

    const sections: string[] = []

    if (this.toolNames.size > 0) {
      sections.push(`使用工具：${Array.from(this.toolNames).join(", ")}`)
    }

    if (this.reasoning) {
      sections.push(this.reasoning)
    }

    return sections.join("\n\n")
  }
}
