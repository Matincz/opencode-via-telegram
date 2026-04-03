import { describe, expect, it } from "bun:test"
import { buildSandboxModePickerMessage } from "./sandbox-mode-picker"

describe("buildSandboxModePickerMessage", () => {
  it("marks on state in the inline keyboard", () => {
    const message = buildSandboxModePickerMessage(true)
    expect(message.options.reply_markup.inline_keyboard[0]?.[0]?.text).toBe("✅ Sandbox On")
    expect(message.options.reply_markup.inline_keyboard[0]?.[1]?.text).toBe("Sandbox Off")
  })

  it("marks off state in the inline keyboard", () => {
    const message = buildSandboxModePickerMessage(false)
    expect(message.options.reply_markup.inline_keyboard[0]?.[0]?.text).toBe("Sandbox On")
    expect(message.options.reply_markup.inline_keyboard[0]?.[1]?.text).toBe("✅ Sandbox Off")
  })
})
