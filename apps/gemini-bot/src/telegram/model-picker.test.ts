import { describe, expect, it } from "bun:test"
import { buildModelPickerMessage } from "./model-picker"

describe("buildModelPickerMessage", () => {
  it("marks the current model in the inline keyboard", () => {
    const message = buildModelPickerMessage(["gemini-2.5-flash", "gemini-2.5-pro"], "gemini-2.5-pro", "gemini-2.5-flash")

    expect(message.text).toContain("当前：<code>gemini-2.5-pro</code>")
    expect(message.text).toContain("原生默认：<code>gemini-2.5-flash</code>")
    expect(message.options.reply_markup.inline_keyboard[2]?.[0]?.text).toBe("✅ gemini-2.5-pro")
  })
})
