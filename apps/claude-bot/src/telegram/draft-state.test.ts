import { describe, expect, it } from "bun:test"
import { ClaudeDraftState } from "./draft-state"

describe("ClaudeDraftState", () => {
  it("renders tool usage and tasks before final text", () => {
    const state = new ClaudeDraftState()

    state.applyEvent({
      type: "tool_use",
      toolName: "Read",
      raw: {},
    })
    state.applyEvent({
      type: "task_started",
      taskId: "t1",
      description: "检查仓库结构",
      raw: {},
    })

    expect(state.render()).toBe("使用工具：Read\n\n子任务：检查仓库结构")
  })

  it("prefers final assistant text once available", () => {
    const state = new ClaudeDraftState()

    state.applyEvent({
      type: "task_started",
      taskId: "t1",
      description: "先整理上下文",
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
