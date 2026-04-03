import { pathToFileURL } from "url"
import type { ResolvedTelegramAttachment } from "../telegram/types"

export interface TextPartInput {
  type: "text"
  text: string
  synthetic?: boolean
}

export interface FilePartInput {
  type: "file"
  mime: string
  filename?: string
  url: string
}

export type PromptPartInput = TextPartInput | FilePartInput

export const ATTACHMENT_ONLY_FALLBACK_TEXT = "[User sent attachment without caption]"

export interface PromptModelCapabilities {
  capabilities?: {
    attachment?: boolean
    input?: {
      image?: boolean
      audio?: boolean
      video?: boolean
      pdf?: boolean
    }
  }
}

const TEXT_LIKE_MIME_PREFIXES = ["text/"]
const TEXT_LIKE_MIME_EXACT = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/x-typescript",
  "application/sql",
])

function toFilePart(attachment: ResolvedTelegramAttachment): FilePartInput {
  return {
    type: "file",
    mime: attachment.mime,
    filename: attachment.filename,
    url: pathToFileURL(attachment.path).href,
  }
}

function isTextLikeMime(mime: string) {
  const normalized = mime.toLowerCase()
  return TEXT_LIKE_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix)) || TEXT_LIKE_MIME_EXACT.has(normalized)
}

function shouldInlineAttachment(attachment: ResolvedTelegramAttachment, model?: PromptModelCapabilities) {
  if (isTextLikeMime(attachment.mime)) return false

  const capabilities = model?.capabilities
  if (!capabilities?.attachment) return false

  if (attachment.mime.startsWith("image/")) return capabilities.input?.image === true
  if (attachment.mime === "application/pdf") return capabilities.input?.pdf === true
  if (attachment.mime.startsWith("audio/")) return capabilities.input?.audio === true
  if (attachment.mime.startsWith("video/")) return capabilities.input?.video === true

  return false
}

function buildDeferredAttachmentNotice(attachments: ResolvedTelegramAttachment): TextPartInput
function buildDeferredAttachmentNotice(attachments: ResolvedTelegramAttachment[]): TextPartInput
function buildDeferredAttachmentNotice(attachments: ResolvedTelegramAttachment | ResolvedTelegramAttachment[]): TextPartInput {
  const list = Array.isArray(attachments) ? attachments : [attachments]
  const lines = [
    "The user attached file(s) that should be accessed via the Read tool if needed:",
    ...list.map((attachment) => `- ${attachment.path} (${attachment.mime})`),
  ]
  return {
    type: "text",
    text: lines.join("\n"),
    synthetic: true,
  }
}

export function buildPromptParts(input: {
  bodyText: string
  attachments: ResolvedTelegramAttachment[]
  model?: PromptModelCapabilities
}): PromptPartInput[] {
  const parts: PromptPartInput[] = []
  const text = input.bodyText.trim()
  const inlineAttachments = input.attachments.filter((attachment) => shouldInlineAttachment(attachment, input.model))
  const deferredAttachments = input.attachments.filter((attachment) => !shouldInlineAttachment(attachment, input.model))

  if (text) {
    parts.push({ type: "text", text })
  } else if (input.attachments.length > 0) {
    parts.push({
      type: "text",
      text: ATTACHMENT_ONLY_FALLBACK_TEXT,
      synthetic: true,
    })
  }

  if (deferredAttachments.length > 0) {
    parts.push(buildDeferredAttachmentNotice(deferredAttachments))
  }

  parts.push(...inlineAttachments.map(toFilePart))
  return parts
}

export function buildCommandFileParts(attachments: ResolvedTelegramAttachment[]): FilePartInput[] {
  return attachments.map(toFilePart)
}
