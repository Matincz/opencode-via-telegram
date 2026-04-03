import { describe, expect, it } from "bun:test"
import { buildClaudeEffortPickerMessage, buildClaudeModelPickerMessage } from "./model-picker"

describe("buildClaudeModelPickerMessage", () => {
  it("includes the current model and effort", () => {
    const message = buildClaudeModelPickerMessage({
      currentModel: "gpt-5.4-mini",
      currentEffort: "high",
      defaultModel: "gpt-5.4-mini",
    })

    expect(message.text).toContain("<code>gpt-5.4-mini</code>")
    expect(message.text).toContain("<code>high</code>")
    expect(message.options.reply_markup.inline_keyboard.flat().map((item) => item.callback_data)).toContain("claude-model:gpt-5.4-mini")
  })
})

describe("buildClaudeEffortPickerMessage", () => {
  it("renders supported efforts", () => {
    const message = buildClaudeEffortPickerMessage({
      modelId: "gpt-5.4-mini",
      currentEffort: "high",
      fallbackEffort: "medium",
    })

    expect(message.text).toContain("<code>gpt-5.4-mini</code>")
    expect(message.options.reply_markup.inline_keyboard.flat().map((item) => item.callback_data)).toContain("claude-effort:high")
  })
})
