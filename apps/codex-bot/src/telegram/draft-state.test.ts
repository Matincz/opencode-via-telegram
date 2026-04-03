import { describe, expect, it } from "bun:test"
import { CodexDraftState } from "./draft-state"

describe("CodexDraftState", () => {
  it("renders tool usage and reasoning before the final message", () => {
    const state = new CodexDraftState()

    state.applyEvent({
      type: "tool_use",
      toolName: "Bash",
      raw: {},
    })
    state.applyEvent({
      type: "reasoning",
      content: "正在检查仓库结构",
      raw: {},
    })

    expect(state.render()).toBe("使用工具：Bash\n\n正在检查仓库结构")
  })

  it("prefers the final assistant message once available", () => {
    const state = new CodexDraftState()

    state.applyEvent({
      type: "reasoning",
      content: "先整理结论",
      raw: {},
    })
    state.applyEvent({
      type: "message",
      content: "这是最终回答",
      raw: {},
    })

    expect(state.render()).toBe("这是最终回答")
  })
})
