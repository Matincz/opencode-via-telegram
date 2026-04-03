import { describe, expect, it } from "bun:test"
import { buildCodexEffortPickerMessage, buildCodexModelPickerMessage } from "./model-picker"

describe("buildCodexModelPickerMessage", () => {
  it("includes the current model and effort", () => {
    const message = buildCodexModelPickerMessage({
      allowedModels: ["gpt-5.4", "gpt-5.4-mini"],
      currentModel: "gpt-5.4",
      currentEffort: "high",
      defaultModel: "gpt-5.4",
    })

    expect(message.text).toContain("<code>gpt-5.4</code>")
    expect(message.text).toContain("<code>high</code>")
  })
})

describe("buildCodexEffortPickerMessage", () => {
  it("renders supported efforts and model default", () => {
    const message = buildCodexEffortPickerMessage({
      model: {
        id: "gpt-5.4",
        displayName: "gpt-5.4",
        description: "test",
        supportedEfforts: ["medium", "high", "xhigh"],
        defaultEffort: "medium",
        isDefault: true,
      },
      currentEffort: "high",
      fallbackEffort: "medium",
    })

    expect(message.text).toContain("<code>gpt-5.4</code>")
    expect(message.options.reply_markup.inline_keyboard.flat().map((item) => item.callback_data)).toContain("codex-effort:high")
  })
})
