import * as fs from "fs"
import * as path from "path"
import { escapeHtml } from "@matincz/telegram-bot-core/telegram/rendering"
import type { ResolvedTelegramAttachment } from "./types"

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function isPreviewableTextAttachment(attachment: ResolvedTelegramAttachment) {
  if (attachment.mime.startsWith("text/")) return true
  const ext = path.extname(attachment.filename).toLowerCase()
  return [
    ".md",
    ".txt",
    ".json",
    ".yaml",
    ".yml",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".sh",
    ".toml",
    ".xml",
    ".html",
    ".css",
    ".sql",
  ].includes(ext)
}

function readPreview(pathname: string) {
  try {
    const raw = fs.readFileSync(pathname, "utf8").replace(/\0/g, "")
    const clipped = raw.slice(0, 800).trim()
    return clipped ? clipped : null
  } catch {
    return null
  }
}

export function buildAttachmentPreviewMessage(attachments: ResolvedTelegramAttachment[]) {
  const lines = ["📎 <b>附件预览</b>"]

  for (const attachment of attachments.slice(0, 4)) {
    lines.push("")
    lines.push(`<b>${escapeHtml(attachment.filename)}</b>`)
    lines.push(`<code>${escapeHtml(attachment.mime)}</code> · <code>${formatBytes(attachment.sizeBytes)}</code>`)

    if (!isPreviewableTextAttachment(attachment)) continue

    const preview = readPreview(attachment.path)
    if (!preview) continue

    lines.push(`<blockquote expandable>${escapeHtml(preview)}</blockquote>`)
  }

  return lines.join("\n")
}
