import { access, mkdir, readdir, rm, stat, writeFile } from "fs/promises"
import * as path from "path"
import type { ResolvedTelegramAttachment, TelegramAttachmentRef } from "./types"

export const TELEGRAM_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024
export const DEFAULT_MEDIA_CACHE_TTL_MS = 6 * 60 * 60 * 1000
export const DEFAULT_MEDIA_CLEANUP_DELAY_MS = 15 * 60 * 1000

export class TelegramMediaError extends Error {
  constructor(
    public readonly code: "too_large" | "download_failed" | "missing_file_path" | "unsupported_media",
    message: string,
  ) {
    super(message)
    this.name = "TelegramMediaError"
  }
}

type GetFileResult = {
  file_path?: string
}

type DownloadAttachmentInput = {
  token: string
  attachment: TelegramAttachmentRef
  getFile: (fileId: string) => Promise<GetFileResult>
  fetchImpl?: typeof fetch
  targetDir: string
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".json": "application/json",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
}

function sanitizeFilename(value: string) {
  return value.replace(/[^\w.\-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "attachment"
}

function inferExtensionFromMime(mime: string) {
  const lower = mime.toLowerCase()
  const match = Object.entries(MIME_BY_EXTENSION).find(([, value]) => value === lower)
  return match?.[0] ?? ""
}

function inferMimeFromFilename(filename: string) {
  const ext = path.extname(filename).toLowerCase()
  return MIME_BY_EXTENSION[ext]
}

function defaultMimeForKind(kind: TelegramAttachmentRef["kind"]) {
  switch (kind) {
    case "photo":
      return "image/jpeg"
    case "voice":
      return "audio/ogg"
    case "video":
      return "video/mp4"
    case "audio":
      return "audio/mpeg"
    case "animation":
      return "video/mp4"
    case "sticker":
      return "image/webp"
    default:
      return "application/octet-stream"
  }
}

function defaultFilename(attachment: TelegramAttachmentRef, filePath?: string, mime?: string) {
  const explicit = attachment.filename?.trim()
  if (explicit) return sanitizeFilename(explicit)

  const basename = filePath ? path.basename(filePath) : ""
  if (basename) return sanitizeFilename(basename)

  const ext = inferExtensionFromMime(mime ?? attachment.mime ?? defaultMimeForKind(attachment.kind))
  return sanitizeFilename(`${attachment.kind}-${attachment.fileUniqueId ?? attachment.messageId}${ext}`)
}

async function downloadAttachment(input: DownloadAttachmentInput): Promise<ResolvedTelegramAttachment> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  if (!fetchImpl) {
    throw new TelegramMediaError("download_failed", "当前运行环境不支持下载 Telegram 文件。")
  }

  if ((input.attachment.fileSize ?? 0) > TELEGRAM_DOWNLOAD_LIMIT_BYTES) {
    throw new TelegramMediaError("too_large", "Telegram 附件超过 20MB 下载上限，无法处理。")
  }

  const file = await input.getFile(input.attachment.fileId)
  if (!file.file_path) {
    throw new TelegramMediaError("missing_file_path", "Telegram 未返回可下载的文件路径。")
  }

  const response = await fetchImpl(`https://api.telegram.org/file/bot${input.token}/${file.file_path}`)
  if (!response.ok) {
    throw new TelegramMediaError("download_failed", `下载 Telegram 附件失败 (${response.status})。`)
  }

  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  if (buffer.byteLength > TELEGRAM_DOWNLOAD_LIMIT_BYTES) {
    throw new TelegramMediaError("too_large", "Telegram 附件超过 20MB 下载上限，无法处理。")
  }

  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim()
  const mime = input.attachment.mime || contentType || inferMimeFromFilename(file.file_path) || defaultMimeForKind(input.attachment.kind)
  const filename = defaultFilename(input.attachment, file.file_path, mime)
  const targetPath = await resolveUniqueTargetPath(input.targetDir, filename)

  await writeFile(targetPath, buffer)

  return {
    kind: input.attachment.kind,
    path: targetPath,
    mime,
    filename,
    telegramFileId: input.attachment.fileId,
    telegramFileUniqueId: input.attachment.fileUniqueId,
    messageId: input.attachment.messageId,
    sizeBytes: buffer.byteLength,
  }
}

async function resolveUniqueTargetPath(targetDir: string, filename: string) {
  const extension = path.extname(filename)
  const basename = extension ? filename.slice(0, -extension.length) : filename
  let attempt = 0

  while (true) {
    const candidateName = attempt === 0 ? filename : `${basename}-${attempt}${extension}`
    const candidatePath = path.join(targetDir, candidateName)
    const exists = await access(candidatePath)
      .then(() => true)
      .catch(() => false)
    if (!exists) return candidatePath
    attempt += 1
  }
}

export function getMediaCacheRoot(cwd = process.cwd()) {
  return path.join(cwd, ".cache", "telegram-media")
}

export async function resolveTelegramAttachments(input: {
  token: string
  attachments: TelegramAttachmentRef[]
  cacheRoot: string
  cacheKey: string
  getFile: (fileId: string) => Promise<GetFileResult>
  fetchImpl?: typeof fetch
}) {
  if (input.attachments.length === 0) return []

  const targetDir = path.join(input.cacheRoot, sanitizeFilename(input.cacheKey))
  await mkdir(targetDir, { recursive: true })

  const resolved: ResolvedTelegramAttachment[] = []
  for (const attachment of input.attachments) {
    resolved.push(
      await downloadAttachment({
        token: input.token,
        attachment,
        getFile: input.getFile,
        fetchImpl: input.fetchImpl,
        targetDir,
      }),
    )
  }
  return resolved
}

async function removeDirectoryIfExists(dir: string) {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

export function scheduleAttachmentCleanup(paths: string[], delayMs = DEFAULT_MEDIA_CLEANUP_DELAY_MS) {
  if (!paths.length) return
  const directories = [...new Set(paths.map((entry) => path.dirname(entry)))]
  setTimeout(() => {
    void Promise.all(directories.map((dir) => removeDirectoryIfExists(dir)))
  }, delayMs)
}

async function walkDirectories(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => [])
  const directories: string[] = []
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name)
    if (entry.isDirectory()) {
      directories.push(fullPath, ...(await walkDirectories(fullPath)))
    }
  }
  return directories
}

export async function cleanupExpiredMediaCache(rootDir: string, ttlMs = DEFAULT_MEDIA_CACHE_TTL_MS) {
  const directories = [rootDir, ...(await walkDirectories(rootDir))]
  const now = Date.now()
  await Promise.all(
    directories.map(async (dir) => {
      const info = await stat(dir).catch(() => null)
      if (!info?.isDirectory()) return
      if (now - info.mtimeMs < ttlMs) return
      await removeDirectoryIfExists(dir)
    }),
  )
}

export function startMediaCacheJanitor(input: { rootDir: string; ttlMs?: number; intervalMs?: number }) {
  const interval = setInterval(() => {
    void cleanupExpiredMediaCache(input.rootDir, input.ttlMs)
  }, input.intervalMs ?? 60 * 60 * 1000)

  const maybeTimer = interval as ReturnType<typeof setInterval> & { unref?: () => void }
  maybeTimer.unref?.()
  return interval
}
