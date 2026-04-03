import { describe, expect, it } from "bun:test"
import { formatGeminiAttachmentReference } from "./attachment-paths"
import { buildPromptFromHistory, formatUserHistoryEntry } from "./prompt"

describe("formatUserHistoryEntry", () => {
  it("records attachment names alongside the user text", () => {
    const text = formatUserHistoryEntry("看一下这个文件", [
      {
        kind: "document",
        path: "/tmp/report.txt",
        mime: "text/plain",
        filename: "report.txt",
        telegramFileId: "file-1",
        messageId: 1,
        sizeBytes: 10,
      },
    ])

    expect(text).toContain("看一下这个文件")
    expect(text).toContain("[Attachments: report.txt]")
  })

  it("creates a fallback instruction for attachment-only messages", () => {
    const text = formatUserHistoryEntry("", [
      {
        kind: "photo",
        path: "/tmp/photo.jpg",
        mime: "image/jpeg",
        filename: "photo.jpg",
        telegramFileId: "file-1",
        messageId: 1,
        sizeBytes: 10,
      },
    ])

    expect(text).toContain("Please analyze the attached file(s)")
  })
})

describe("buildPromptFromHistory", () => {
  it("injects attachment references as @paths", () => {
    const prompt = buildPromptFromHistory({
      history: [
        {
          role: "user",
          text: "之前的问题",
          createdAt: "2026-03-20T00:00:00.000Z",
        },
      ],
      userText: "总结这个附件",
      attachments: [
        {
          kind: "document",
          path: "/tmp/report.txt",
          mime: "text/plain",
          filename: "report.txt",
          telegramFileId: "file-1",
          messageId: 1,
          sizeBytes: 10,
        },
      ],
    })

    expect(prompt).toContain("总结这个附件")
    expect(prompt).toContain("- @/tmp/report.txt")
  })

  it("escapes attachment paths with spaces for Gemini @path parsing", () => {
    const prompt = buildPromptFromHistory({
      history: [],
      userText: "看图",
      attachments: [
        {
          kind: "photo",
          path: "/Users/matincz/agents via telegram/telegram files/photo 1.webp",
          mime: "image/webp",
          filename: "photo 1.webp",
          telegramFileId: "file-1",
          messageId: 1,
          sizeBytes: 10,
        },
      ],
    })

    expect(prompt).toContain(`- ${formatGeminiAttachmentReference("/Users/matincz/agents via telegram/telegram files/photo 1.webp")}`)
  })
})
