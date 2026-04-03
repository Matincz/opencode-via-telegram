import { describe, expect, it } from "bun:test"
import { applyClaudeStreamLine, buildClaudeArgs, parseClaudeStreamEvent } from "./client"

describe("parseClaudeStreamEvent", () => {
  it("captures assistant text messages", () => {
    expect(parseClaudeStreamEvent({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "pong" },
        ],
      },
    })).toMatchObject({
      type: "message",
      content: "pong",
    })
  })

  it("captures partial assistant deltas", () => {
    expect(parseClaudeStreamEvent({
      type: "partial_assistant",
      message: {
        content: [
          { type: "text", text: "par" },
          { type: "text", text: "tial" },
        ],
      },
    })).toMatchObject({
      type: "text_delta",
      content: "partial",
    })
  })

  it("captures tool use blocks", () => {
    expect(parseClaudeStreamEvent({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "a.ts" } },
        ],
      },
    })).toMatchObject({
      type: "tool_use",
      toolName: "Read",
      toolInput: { file_path: "a.ts" },
    })
  })

  it("captures successful results", () => {
    expect(parseClaudeStreamEvent({
      type: "result",
      subtype: "success",
      result: "done",
      cost_usd: 0.12,
    })).toMatchObject({
      type: "result",
      resultText: "done",
      costUSD: 0.12,
    })
  })
})

describe("applyClaudeStreamLine", () => {
  it("tracks session ids from payloads", () => {
    const result = applyClaudeStreamLine({ text: "" }, JSON.stringify({
      type: "assistant",
      session_id: "session_1",
      message: {
        content: [
          { type: "text", text: "hello" },
        ],
      },
    }))

    expect(result.state.sessionId).toBe("session_1")
    expect(result.state.text).toBe("hello")
  })

  it("stores result text and cost", () => {
    const result = applyClaudeStreamLine({ text: "draft" }, JSON.stringify({
      type: "result",
      subtype: "success",
      result: "final",
      cost_usd: 1.5,
      session_id: "session_2",
    }))

    expect(result.state.sessionId).toBe("session_2")
    expect(result.state.text).toBe("final")
    expect(result.state.costUSD).toBe(1.5)
  })
})

describe("buildClaudeArgs", () => {
  it("builds a fresh prompt command", () => {
    const args = buildClaudeArgs({
      prompt: "hello",
      model: "sonnet",
      effort: "high",
      permissionMode: "bypassPermissions",
      addDirectories: ["/tmp/one", "/tmp/one"],
      maxTurns: 5,
    })

    expect(args.slice(0, 4)).toEqual(["-p", "--verbose", "--output-format", "stream-json"])
    expect(args).toContain("--dangerously-skip-permissions")
    expect(args).toContain("--model")
    expect(args).toContain("sonnet")
    expect(args).toContain("--effort")
    expect(args).toContain("high")
    expect(args).toContain("--max-turns")
    expect(args).toContain("5")
    expect(args.filter((entry) => entry === "--add-dir")).toHaveLength(1)
    expect(args.at(-1)).toBe("hello")
  })

  it("builds a resume command", () => {
    const args = buildClaudeArgs({
      prompt: "continue",
      resume: "session_1",
      permissionMode: "acceptEdits",
    })

    expect(args).toContain("--resume")
    expect(args).toContain("session_1")
    expect(args).toContain("--permission-mode")
    expect(args).toContain("acceptEdits")
    expect(args.at(-1)).toBe("continue")
  })
})
