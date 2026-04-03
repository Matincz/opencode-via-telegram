import { describe, expect, it } from "bun:test"
import { buildSessionPickerMessage } from "./session-picker"

describe("buildSessionPickerMessage", () => {
  it("renders resume/delete buttons for recent sessions", () => {
    const message = buildSessionPickerMessage([
      {
        index: 1,
        summary: "first session",
        relativeTime: "1 hour ago",
        sessionId: "fcdd4a5c-08e7-4077-9e20-54d472dacc18",
      },
    ], "fcdd4a5c-08e7-4077-9e20-54d472dacc18")

    expect(message.text).toContain("<- 当前")
    expect(message.options.reply_markup.inline_keyboard[0]?.[0]?.callback_data).toBe("session:resume:fcdd4a5c-08e7-4077-9e20-54d472dacc18")
    expect(message.options.reply_markup.inline_keyboard[0]?.[1]?.callback_data).toBe("session:delete:1")
  })
})
