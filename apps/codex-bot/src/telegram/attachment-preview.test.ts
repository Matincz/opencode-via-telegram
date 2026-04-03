import { describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import * as os from "os"
import * as path from "path"
import { buildAttachmentPreviewMessage } from "./attachment-preview"

describe("buildAttachmentPreviewMessage", () => {
  it("renders text attachment excerpts", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "codex-preview-"))
    const filePath = path.join(dir, "demo.ts")
    writeFileSync(filePath, "const value = 1\\nconsole.log(value)\\n")

    try {
      const message = buildAttachmentPreviewMessage([
        {
          kind: "document",
          path: filePath,
          mime: "text/plain",
          filename: "demo.ts",
          telegramFileId: "f1",
          messageId: 1,
          sizeBytes: 32,
        },
      ])

      expect(message).toContain("附件预览")
      expect(message).toContain("demo.ts")
      expect(message).toContain("const value = 1")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
