import { describe, expect, it } from "bun:test"
import { ToolStatusTracker } from "./tool-status"

describe("ToolStatusTracker", () => {
  it("renders running tools in order", () => {
    const tracker = new ToolStatusTracker()
    tracker.addToolUse("Read")
    tracker.addToolUse("Bash")

    expect(tracker.renderPlain()).toBe("🛠 工具执行状态\n\n⏳ Read\n⏳ Bash")
  })

  it("updates progress and completion", () => {
    const tracker = new ToolStatusTracker()
    tracker.addToolUse("Read")
    tracker.addToolProgress("Read", "scanning src")
    tracker.markToolResult("Read", "done")

    expect(tracker.renderPlain()).toBe("🛠 工具执行状态\n\n✅ Read · scanning src")
  })
})
