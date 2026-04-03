import { describe, expect, it } from "bun:test"
import { applyCodexStreamLine, buildCodexArgs, parseCodexStreamEvent } from "./client"

describe("parseCodexStreamEvent", () => {
  it("captures thread.started as init", () => {
    expect(parseCodexStreamEvent({
      type: "thread.started",
      thread_id: "thread_1",
    })).toMatchObject({
      type: "init",
      sessionId: "thread_1",
    })
  })

  it("captures completed agent messages", () => {
    expect(parseCodexStreamEvent({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "pong",
      },
    })).toMatchObject({
      type: "message",
      content: "pong",
    })
  })

  it("captures tool items on start", () => {
    expect(parseCodexStreamEvent({
      type: "item.started",
      item: {
        type: "command_execution",
      },
    })).toMatchObject({
      type: "tool_use",
      toolName: "Bash",
    })
  })
})

describe("applyCodexStreamLine", () => {
  it("tracks the current thread id", () => {
    const result = applyCodexStreamLine({ text: "" }, JSON.stringify({
      type: "thread.started",
      thread_id: "thread_1",
    }))

    expect(result.state.sessionId).toBe("thread_1")
  })

  it("stores the final assistant message", () => {
    const result = applyCodexStreamLine({ text: "" }, JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "done",
      },
    }))

    expect(result.state.text).toBe("done")
  })

  it("tracks final usage on turn.completed", () => {
    const result = applyCodexStreamLine({ text: "done" }, JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1, output_tokens: 2 },
    }))

    expect(result.state.usage).toEqual({ input_tokens: 1, output_tokens: 2 })
  })
})

describe("buildCodexArgs", () => {
  it("builds a fresh exec command with model, images, and add-dir", () => {
    const args = buildCodexArgs({
      prompt: "hello",
      model: "gpt-5.4",
      reasoningEffort: "high",
      images: ["/tmp/image.png"],
      addDirectories: ["/tmp", "/tmp"],
      permissionMode: "workspace-write",
    })

    expect(args).toContain("exec")
    expect(args).toContain("--model")
    expect(args).toContain("gpt-5.4")
    expect(args).toContain("--image")
    expect(args).toContain("/tmp/image.png")
    expect(args).toContain("--add-dir")
    expect(args.at(-1)).toBe("hello")
  })

  it("builds a resume command", () => {
    const args = buildCodexArgs({
      prompt: "continue",
      resume: "thread_1",
      addDirectories: ["/tmp/one", "/tmp/two"],
      permissionMode: "bypassPermissions",
    })

    expect(args.slice(0, 3)).toEqual(["exec", "resume", "--json"])
    expect(args).toContain("thread_1")
    expect(args.at(-1)).toBe("continue")
    expect(args).not.toContain("--add-dir")
  })
})
