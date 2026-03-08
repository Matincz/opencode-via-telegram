import { describe, expect, it } from "bun:test"
import { ATTACHMENT_ONLY_FALLBACK_TEXT, buildCommandFileParts, buildPromptParts } from "./parts"
import type { ResolvedTelegramAttachment } from "../telegram/types"

const attachment: ResolvedTelegramAttachment = {
  kind: "photo",
  path: "/tmp/example.png",
  mime: "image/png",
  filename: "example.png",
  telegramFileId: "file-1",
  telegramFileUniqueId: "unique-1",
  messageId: 10,
  sizeBytes: 123,
}

describe("buildPromptParts", () => {
  const imageCapableModel = {
    capabilities: {
      attachment: true,
      input: {
        image: true,
      },
    },
  }

  it("keeps text first and appends supported image file parts", () => {
    const parts = buildPromptParts({
      bodyText: "请分析这张图",
      attachments: [attachment],
      model: imageCapableModel,
    })

    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual({ type: "text", text: "请分析这张图" })
    expect(parts[1]).toEqual({
      type: "file",
      mime: "image/png",
      filename: "example.png",
      url: "file:///tmp/example.png",
    })
  })

  it("injects fallback text when attachments arrive without caption", () => {
    const parts = buildPromptParts({
      bodyText: "",
      attachments: [attachment],
      model: imageCapableModel,
    })

    expect(parts[0]).toEqual({
      type: "text",
      text: ATTACHMENT_ONLY_FALLBACK_TEXT,
      synthetic: true,
    })
  })

  it("downgrades text-like files to read-tool notices", () => {
    const markdownAttachment: ResolvedTelegramAttachment = {
      ...attachment,
      path: "/tmp/example.md",
      mime: "text/markdown",
      filename: "example.md",
    }

    const parts = buildPromptParts({
      bodyText: "帮我看看这个文档",
      attachments: [markdownAttachment],
      model: imageCapableModel,
    })

    expect(parts).toEqual([
      { type: "text", text: "帮我看看这个文档" },
      {
        type: "text",
        text: "The user attached file(s) that should be accessed via the Read tool if needed:\n- /tmp/example.md (text/markdown)",
        synthetic: true,
      },
    ])
  })

  it("downgrades unsupported binary files when the model lacks input support", () => {
    const pdfAttachment: ResolvedTelegramAttachment = {
      ...attachment,
      path: "/tmp/example.pdf",
      mime: "application/pdf",
      filename: "example.pdf",
    }

    const parts = buildPromptParts({
      bodyText: "总结这个 PDF",
      attachments: [pdfAttachment],
      model: imageCapableModel,
    })

    expect(parts).toEqual([
      { type: "text", text: "总结这个 PDF" },
      {
        type: "text",
        text: "The user attached file(s) that should be accessed via the Read tool if needed:\n- /tmp/example.pdf (application/pdf)",
        synthetic: true,
      },
    ])
  })
})

describe("buildCommandFileParts", () => {
  it("builds file-only command parts", () => {
    expect(buildCommandFileParts([attachment])).toEqual([
      {
        type: "file",
        mime: "image/png",
        filename: "example.png",
        url: "file:///tmp/example.png",
      },
    ])
  })
})
