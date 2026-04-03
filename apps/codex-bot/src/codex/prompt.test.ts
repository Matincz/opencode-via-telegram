import { describe, expect, it } from "bun:test"
import { buildCodexPrompt } from "./prompt"

describe("buildCodexPrompt", () => {
  it("includes the current request text", () => {
    const prompt = buildCodexPrompt({
      userText: "帮我看一下这段代码",
      attachments: [],
    })

    expect(prompt).toContain("帮我看一下这段代码")
    expect(prompt).toContain("<current_request>")
  })

  it("includes attachment filenames, mime types, and paths", () => {
    const prompt = buildCodexPrompt({
      userText: "看图",
      attachments: [
        {
          kind: "photo",
          path: "/tmp/photo 1.webp",
          mime: "image/webp",
          filename: "photo 1.webp",
          telegramFileId: "file-1",
          messageId: 1,
          sizeBytes: 10,
        },
      ],
    })

    expect(prompt).toContain("photo 1.webp (image/webp) - /tmp/photo 1.webp")
  })

  it("includes main memory when provided", () => {
    const prompt = buildCodexPrompt({
      userText: "继续",
      attachments: [],
      mainMemory: "# Main Memory\n- prefers concise answers",
    })

    expect(prompt).toContain("<main_memory>")
    expect(prompt).toContain("prefers concise answers")
  })
})
