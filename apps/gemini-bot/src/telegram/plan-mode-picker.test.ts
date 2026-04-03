import { describe, expect, it } from "bun:test"
import { buildPlanModePickerMessage } from "./plan-mode-picker"

describe("buildPlanModePickerMessage", () => {
  it("marks on state in the inline keyboard", () => {
    const message = buildPlanModePickerMessage(true)
    expect(message.options.reply_markup.inline_keyboard[0]?.[0]?.text).toBe("✅ Plan On")
    expect(message.options.reply_markup.inline_keyboard[0]?.[1]?.text).toBe("Plan Off")
  })

  it("marks off state in the inline keyboard", () => {
    const message = buildPlanModePickerMessage(false)
    expect(message.options.reply_markup.inline_keyboard[0]?.[0]?.text).toBe("Plan On")
    expect(message.options.reply_markup.inline_keyboard[0]?.[1]?.text).toBe("✅ Plan Off")
  })
})
