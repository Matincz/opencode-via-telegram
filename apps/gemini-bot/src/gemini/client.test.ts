import { describe, expect, it } from "bun:test"
import {
  applyGeminiStreamLine,
  buildGeminiRunResult,
  buildPartialGeminiRunResult,
  formatGeminiTimeoutMessage,
  GeminiCliError,
  isRetryableGeminiErrorMessage,
  parseGeminiStreamEvent,
  resolveGeminiInactivityTimeoutMs,
} from "./client"

describe("applyGeminiStreamLine", () => {
  it("captures init session id", () => {
    const result = applyGeminiStreamLine({ text: "" }, JSON.stringify({
      type: "init",
      session_id: "ses_1",
    }))

    expect(result.state.sessionId).toBe("ses_1")
  })

  it("captures init model id", () => {
    const result = applyGeminiStreamLine({ text: "" }, JSON.stringify({
      type: "init",
      session_id: "ses_1",
      model: "gemini-3.1-pro-preview",
    }))

    expect(result.state.model).toBe("gemini-3.1-pro-preview")
  })

  it("appends assistant delta chunks", () => {
    let state = { text: "" }

    state = applyGeminiStreamLine(state, JSON.stringify({
      type: "message",
      role: "assistant",
      content: "he",
      delta: true,
    })).state

    state = applyGeminiStreamLine(state, JSON.stringify({
      type: "message",
      role: "assistant",
      content: "llo",
      delta: true,
    })).state

    expect(state.text).toBe("hello")
  })

  it("captures result stats", () => {
    const result = applyGeminiStreamLine({ text: "hi" }, JSON.stringify({
      type: "result",
      stats: { total_tokens: 10 },
    }))

    expect(result.state.stats).toEqual({ total_tokens: 10 })
  })

  it("captures tool use events", () => {
    const result = applyGeminiStreamLine({ text: "" }, JSON.stringify({
      type: "tool_use",
      name: "run_shell_command",
      tool_call_id: "call_1",
      input: { command: "ls" },
    }))

    expect(result.event).toMatchObject({
      type: "tool_use",
      name: "run_shell_command",
      toolCallId: "call_1",
      input: { command: "ls" },
    })
  })

  it("captures tool result events", () => {
    const result = applyGeminiStreamLine({ text: "" }, JSON.stringify({
      type: "tool_result",
      tool_name: "run_shell_command",
      tool_call_id: "call_1",
      output: "ok",
      success: true,
    }))

    expect(result.event).toMatchObject({
      type: "tool_result",
      toolName: "run_shell_command",
      toolCallId: "call_1",
      output: "ok",
      success: true,
    })
  })

  it("captures error events", () => {
    const result = applyGeminiStreamLine({ text: "" }, JSON.stringify({
      type: "error",
      message: "something failed",
      code: "E_FAIL",
    }))

    expect(result.event).toMatchObject({
      type: "error",
      message: "something failed",
      code: "E_FAIL",
    })
  })
})

describe("parseGeminiStreamEvent", () => {
  it("preserves unknown event types as structured events", () => {
    const event = parseGeminiStreamEvent({
      type: "tool_use",
      name: "fetch",
      input: { url: "https://example.com" },
    })

    expect(event).toMatchObject({
      type: "tool_use",
      name: "fetch",
      input: { url: "https://example.com" },
    })
  })
})

describe("isRetryableGeminiErrorMessage", () => {
  it("detects transient network failures", () => {
    expect(isRetryableGeminiErrorMessage(
      "request to https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist failed, reason: Client network socket disconnected before secure TLS connection was established",
    )).toBe(true)
  })

  it("ignores permanent input errors", () => {
    expect(isRetryableGeminiErrorMessage(
      "Error resuming session: Invalid session identifier \"gem_ses_xxx\".",
    )).toBe(false)
  })
})

describe("formatGeminiTimeoutMessage", () => {
  it("turns undefined stderr into a clearer auth-hang hint when no assistant output arrived", () => {
    const message = formatGeminiTimeoutMessage(90000, "error: undefined,\n[timeout] Gemini CLI exceeded 90000ms", {
      sessionId: "ses_1",
      text: "",
    })

    expect(message).toContain("OAuth headless 认证链可能卡住")
    expect(message).toContain("error: undefined,")
  })

  it("keeps explicit stderr summaries intact", () => {
    const message = formatGeminiTimeoutMessage(90000, "Error: fetch failed", {
      sessionId: "ses_1",
      text: "partial",
    })

    expect(message).toBe("Gemini CLI 请求超时（90000ms）：Error: fetch failed")
  })
})

describe("resolveGeminiInactivityTimeoutMs", () => {
  it("keeps the initial timeout before any execution progress", () => {
    const timeoutMs = resolveGeminiInactivityTimeoutMs({
      state: { sessionId: "ses_1", text: "" },
      initialInactivityMs: 90000,
      progressInactivityMs: 300000,
    })

    expect(timeoutMs).toBe(90000)
  })

  it("switches to the longer timeout after assistant text starts streaming", () => {
    const timeoutMs = resolveGeminiInactivityTimeoutMs({
      state: { sessionId: "ses_1", text: "partial answer" },
      initialInactivityMs: 90000,
      progressInactivityMs: 300000,
    })

    expect(timeoutMs).toBe(300000)
  })

  it("switches to the longer timeout once tool execution begins", () => {
    const timeoutMs = resolveGeminiInactivityTimeoutMs({
      state: { sessionId: "ses_1", text: "" },
      event: {
        type: "tool_use",
        raw: {},
        toolName: "run_shell_command",
      },
      initialInactivityMs: 90000,
      progressInactivityMs: 300000,
    })

    expect(timeoutMs).toBe(300000)
  })
})

describe("buildPartialGeminiRunResult", () => {
  it("returns a partial timed-out result when text is already available", () => {
    const result = buildPartialGeminiRunResult({
      sessionId: "ses_1",
      model: "gemini-2.5-pro",
      text: "partial answer",
      stats: { output_tokens: 12 },
    })

    expect(result).toEqual({
      sessionId: "ses_1",
      model: "gemini-2.5-pro",
      text: "partial answer",
      stats: { output_tokens: 12 },
      isPartial: true,
      timedOut: true,
    })
  })

  it("returns null when no assistant text has arrived", () => {
    const result = buildPartialGeminiRunResult({
      sessionId: "ses_1",
      text: "   ",
    })

    expect(result).toBeNull()
  })
})

describe("GeminiCliError", () => {
  it("keeps session metadata on recoverable failures", () => {
    const error = new GeminiCliError("timeout", {
      sessionId: "ses_1",
      model: "gemini-2.5-pro",
      partialText: "partial answer",
      timedOut: true,
    })

    expect(error.sessionId).toBe("ses_1")
    expect(error.model).toBe("gemini-2.5-pro")
    expect(error.partialText).toBe("partial answer")
    expect(error.timedOut).toBe(true)
  })
})

describe("buildGeminiRunResult", () => {
  it("normalizes the final run result shape", () => {
    const result = buildGeminiRunResult({
      sessionId: "ses_1",
      model: "gemini-2.5-pro",
      text: "done  ",
    })

    expect(result).toEqual({
      sessionId: "ses_1",
      model: "gemini-2.5-pro",
      text: "done",
      stats: undefined,
      isPartial: false,
      timedOut: false,
    })
  })
})
