import { describe, expect, test } from "bun:test"
import { ToolStatusTracker, buildApprovalPromptMessage } from "./tool-status"

describe("ToolStatusTracker", () => {
  test("tracks tool use and result", () => {
    const tracker = new ToolStatusTracker()
    expect(tracker.isEmpty).toBe(true)

    tracker.addToolUse("ReadFile")
    expect(tracker.isEmpty).toBe(false)

    const html = tracker.renderHtml()
    expect(html).toContain("ReadFile")
    expect(html).toContain("⏳")

    tracker.completeToolResult("ReadFile", true)
    const htmlDone = tracker.renderHtml()
    expect(htmlDone).toContain("✅")
  })

  test("tracks failed tool results", () => {
    const tracker = new ToolStatusTracker()
    tracker.addToolUse("Bash")
    tracker.completeToolResult("Bash", false)
    expect(tracker.renderPlain()).toContain("❌")
  })

  test("limits entries to maxEntries", () => {
    const tracker = new ToolStatusTracker(3)
    tracker.addToolUse("A")
    tracker.addToolUse("B")
    tracker.addToolUse("C")
    tracker.addToolUse("D")
    const plain = tracker.renderPlain()
    expect(plain).not.toContain("A")
    expect(plain).toContain("B")
    expect(plain).toContain("D")
  })

  test("clear resets state", () => {
    const tracker = new ToolStatusTracker()
    tracker.addToolUse("X")
    tracker.clear()
    expect(tracker.isEmpty).toBe(true)
  })
})

describe("buildApprovalPromptMessage", () => {
  test("renders plan text and buttons", () => {
    const result = buildApprovalPromptMessage({
      planText: "do something",
      toolSummary: ["ReadFile", "Bash"],
      token: "token123",
      todoSummary: ["read", "write"],
    })
    expect(result.text).toContain("执行计划审批")
    expect(result.text).toContain("do something")
    expect(result.text).toContain("ReadFile")
    expect(result.text).toContain("read")
    expect(result.options.reply_markup.inline_keyboard.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(result.options.reply_markup)).toContain("gplan:once:token123")
    expect(JSON.stringify(result.options.reply_markup)).toContain("gplan:always:token123")
    expect(JSON.stringify(result.options.reply_markup)).toContain("gplan:reject:token123")
  })
})
