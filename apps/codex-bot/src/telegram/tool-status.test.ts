import { describe, expect, it } from "bun:test"
import { ToolStatusTracker } from "./tool-status"

describe("ToolStatusTracker", () => {
  it("renders running tools in order", () => {
    const tracker = new ToolStatusTracker()
    tracker.addToolUse("Bash")
    tracker.addToolUse("Edit")

    expect(tracker.renderPlain()).toBe("🛠 工具执行状态\n\n⏳ Bash\n⏳ Edit")
  })

  it("drops older entries over capacity", () => {
    const tracker = new ToolStatusTracker(2)
    tracker.addToolUse("Bash")
    tracker.addToolUse("Edit")
    tracker.addToolUse("WebSearch")

    expect(tracker.renderPlain()).toBe("🛠 工具执行状态\n\n⏳ Edit\n⏳ WebSearch")
  })
})
