import { describe, expect, it } from "bun:test"
import { hasTelegramAttachments, normalizeTelegramMessages, parseCommandText, shouldUseMediaGroupBuffer } from "./inbound"
import type { TelegramMessageLike } from "./types"

describe("normalizeTelegramMessages", () => {
  it("normalizes media groups with caption and multiple attachments", () => {
    const messages: TelegramMessageLike[] = [
      {
        message_id: 100,
        media_group_id: "grp-1",
        chat: { id: 1, type: "private" },
        from: { id: 2 },
        caption: "请比较这两张图",
        photo: [{ file_id: "photo-1-small" }, { file_id: "photo-1-large", file_unique_id: "u1", file_size: 100 }],
      },
      {
        message_id: 101,
        media_group_id: "grp-1",
        chat: { id: 1, type: "private" },
        from: { id: 2 },
        photo: [{ file_id: "photo-2-small" }, { file_id: "photo-2-large", file_unique_id: "u2", file_size: 120 }],
      },
    ]

    const normalized = normalizeTelegramMessages(messages)
    expect(normalized).not.toBeNull()
    expect(normalized?.bodyText).toBe("请比较这两张图")
    expect(normalized?.attachments).toHaveLength(2)
    expect(normalized?.messageIds).toEqual([100, 101])
  })

  it("preserves media-only messages with empty body", () => {
    const normalized = normalizeTelegramMessages([
      {
        message_id: 1,
        chat: { id: 1, type: "private" },
        photo: [{ file_id: "photo-1" }],
      },
    ])

    expect(normalized?.bodyText).toBe("")
    expect(normalized?.bodySource).toBe("synthetic")
  })
})

describe("command parsing", () => {
  it("parses slash commands from captions", () => {
    expect(parseCommandText("/vision describe this")).toEqual({
      cmd: "/vision",
      args: "describe this",
    })
  })
})

describe("attachment helpers", () => {
  it("detects attachments and media-group buffering", () => {
    const message: TelegramMessageLike = {
      message_id: 1,
      media_group_id: "grp-1",
      chat: { id: 1, type: "private" },
      document: { file_id: "doc-1", file_name: "report.pdf", mime_type: "application/pdf" },
    }

    expect(hasTelegramAttachments(message)).toBe(true)
    expect(shouldUseMediaGroupBuffer(message)).toBe(true)
  })
})
