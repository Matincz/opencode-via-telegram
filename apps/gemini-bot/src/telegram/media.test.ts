import { afterEach, describe, expect, it, mock } from "bun:test"
import { mkdtemp, readFile, rm } from "fs/promises"
import * as os from "os"
import * as path from "path"
import { getMediaCacheRoot, resolveTelegramAttachments, TELEGRAM_DOWNLOAD_LIMIT_BYTES, TelegramMediaError } from "./media"
import type { TelegramAttachmentRef } from "./types"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  mock.restore()
})

describe("resolveTelegramAttachments", () => {
  it("defaults the media cache root to a workspace-local cache directory", () => {
    expect(getMediaCacheRoot()).toBe(path.join(process.cwd(), ".cache", "telegram-media"))
  })

  it("downloads Telegram files into the cache directory", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "tg-media-"))
    tempDirs.push(cacheRoot)

    const getFile = mock(async (_fileId: string) => ({ file_path: "documents/report.txt" }))
    const fetchImpl = mock(async (_url: string) => new Response("hello world", { headers: { "Content-Type": "text/plain" } }))

    const attachments = await resolveTelegramAttachments({
      token: "token",
      attachments: [
        {
          kind: "document",
          fileId: "doc-1",
          fileUniqueId: "unique-1",
          filename: "report.txt",
          mime: "text/plain",
          messageId: 1,
        },
      ],
      cacheRoot,
      cacheKey: "chat-1-msg-1",
      getFile,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(attachments).toHaveLength(1)
    expect(attachments[0]?.filename).toBe("report.txt")
    expect(await readFile(attachments[0]!.path, "utf8")).toBe("hello world")
  })

  it("rejects files above Telegram Bot API download limit", async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "tg-media-"))
    tempDirs.push(cacheRoot)

    const attachment: TelegramAttachmentRef = {
      kind: "document",
      fileId: "doc-1",
      fileUniqueId: "unique-1",
      filename: "too-large.bin",
      mime: "application/octet-stream",
      fileSize: TELEGRAM_DOWNLOAD_LIMIT_BYTES + 1,
      messageId: 1,
    }

    await expect(
      resolveTelegramAttachments({
        token: "token",
        attachments: [attachment],
        cacheRoot,
        cacheKey: "chat-1-msg-1",
        getFile: async () => ({ file_path: "documents/too-large.bin" }),
      }),
    ).rejects.toBeInstanceOf(TelegramMediaError)
  })
})
