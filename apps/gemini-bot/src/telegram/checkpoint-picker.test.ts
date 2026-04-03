import { describe, expect, it } from "bun:test"
import { buildCheckpointPickerMessage } from "./checkpoint-picker"

describe("buildCheckpointPickerMessage", () => {
  it("renders restore/delete buttons", () => {
    const message = buildCheckpointPickerMessage([
      { id: "cp_abc12345", title: "release-plan", createdAt: "2026-03-20T00:00:00.000Z", model: "auto-gemini-3", history: [] },
    ])

    expect(message.text).toContain("Telegram Checkpoints")
    expect(message.options.reply_markup.inline_keyboard[0]?.[0]?.callback_data).toBe("checkpoint:restore:cp_abc12345")
    expect(message.options.reply_markup.inline_keyboard[0]?.[1]?.callback_data).toBe("checkpoint:delete:cp_abc12345")
  })
})
