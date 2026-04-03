import type { NormalizedInboundMessage, TelegramAttachmentRef, TelegramMessageLike } from "./types"

const TEXT_ATTACHMENT_KINDS = new Set(["document", "video", "audio", "voice", "animation"])

function resolvePhotoAttachment(msg: TelegramMessageLike): TelegramAttachmentRef[] {
  const largest = Array.isArray(msg.photo) && msg.photo.length > 0 ? msg.photo[msg.photo.length - 1] : undefined
  if (!largest?.file_id) return []
  return [
    {
      kind: "photo",
      fileId: largest.file_id,
      fileUniqueId: largest.file_unique_id,
      fileSize: largest.file_size,
      mime: "image/jpeg",
      messageId: msg.message_id,
    },
  ]
}

function resolveFileAttachment(
  kind: TelegramAttachmentRef["kind"],
  file: TelegramMessageLike["document"] | TelegramMessageLike["video"] | TelegramMessageLike["audio"] | TelegramMessageLike["voice"] | TelegramMessageLike["animation"],
  messageId: number,
): TelegramAttachmentRef[] {
  if (!file?.file_id) return []
  return [
    {
      kind,
      fileId: file.file_id,
      fileUniqueId: file.file_unique_id,
      fileSize: file.file_size,
      filename: file.file_name,
      mime: file.mime_type,
      messageId,
    },
  ]
}

function resolveStickerAttachment(msg: TelegramMessageLike): TelegramAttachmentRef[] {
  const sticker = msg.sticker
  if (!sticker?.file_id) return []
  if (sticker.is_animated || sticker.is_video) return []
  return [
    {
      kind: "sticker",
      fileId: sticker.file_id,
      fileUniqueId: sticker.file_unique_id,
      fileSize: sticker.file_size,
      mime: "image/webp",
      messageId: msg.message_id,
    },
  ]
}

export function extractTelegramAttachmentRefs(msg: TelegramMessageLike): TelegramAttachmentRef[] {
  return [
    ...resolvePhotoAttachment(msg),
    ...resolveFileAttachment("document", msg.document, msg.message_id),
    ...resolveFileAttachment("video", msg.video, msg.message_id),
    ...resolveFileAttachment("audio", msg.audio, msg.message_id),
    ...resolveFileAttachment("voice", msg.voice, msg.message_id),
    ...resolveFileAttachment("animation", msg.animation, msg.message_id),
    ...resolveStickerAttachment(msg),
  ]
}

export function hasTelegramAttachments(msg: TelegramMessageLike): boolean {
  return extractTelegramAttachmentRefs(msg).length > 0
}

export function normalizeTelegramMessages(messages: TelegramMessageLike[]): NormalizedInboundMessage | null {
  if (!messages.length) return null

  const sorted = messages.slice().sort((a, b) => a.message_id - b.message_id)
  const primary = sorted[0]
  const bodySourceMessage = sorted.find((msg) => (msg.text ?? "").trim() || (msg.caption ?? "").trim())

  const rawText = (bodySourceMessage?.text ?? "").trim()
  const rawCaption = (bodySourceMessage?.caption ?? "").trim()
  const bodyText = rawText || rawCaption

  const attachments = sorted.flatMap((msg) => extractTelegramAttachmentRefs(msg))
  if (!bodyText && attachments.length === 0) return null

  return {
    chatId: primary.chat.id,
    messageId: sorted[sorted.length - 1]!.message_id,
    messageIds: sorted.map((msg) => msg.message_id),
    mediaGroupId: primary.media_group_id,
    fromUserId: primary.from?.id,
    bodyText,
    bodySource: rawText ? "text" : rawCaption ? "caption" : attachments.length > 0 ? "synthetic" : "none",
    attachments,
    replyToMessageId: primary.reply_to_message?.message_id,
    replyToText: (primary.reply_to_message?.text ?? primary.reply_to_message?.caption ?? "").trim() || undefined,
  }
}

export function parseCommandText(bodyText: string): { cmd: string; args: string } | null {
  const trimmed = bodyText.trim()
  if (!trimmed.startsWith("/")) return null
  const commandToken = trimmed.split(/\s+/, 1)[0] ?? ""
  const bareToken = commandToken.includes("@") ? commandToken.slice(0, commandToken.indexOf("@")) : commandToken
  const cmd = bareToken.toLowerCase()
  const args = trimmed.slice(commandToken.length).trim()
  return { cmd, args }
}

export function shouldUseMediaGroupBuffer(msg: TelegramMessageLike): boolean {
  return Boolean(msg.media_group_id) && hasTelegramAttachments(msg)
}

export function inferCaptionOnlyAttachmentKindCount(msg: TelegramMessageLike): number {
  return extractTelegramAttachmentRefs(msg).filter((attachment) => TEXT_ATTACHMENT_KINDS.has(attachment.kind)).length
}
