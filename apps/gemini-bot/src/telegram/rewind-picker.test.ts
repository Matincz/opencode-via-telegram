import { describe, expect, it } from "bun:test"
import { buildRewindPickerMessage } from "./rewind-picker"

describe("buildRewindPickerMessage", () => {
  it("renders restore buttons", () => {
    const message = buildRewindPickerMessage([
      { id: "rw_abc12345", title: "修复前", createdAt: "2026-03-20T00:00:00.000Z", model: "auto-gemini-3", history: [] },
    ])

    expect(message.text).toContain("Rewind 快照")
    expect(message.options.reply_markup.inline_keyboard[0]?.[0]?.callback_data).toBe("rewind:restore:rw_abc12345")
  })
})
