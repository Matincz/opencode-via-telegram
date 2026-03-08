export type TelegramAttachmentKind =
  | "photo"
  | "document"
  | "video"
  | "audio"
  | "voice"
  | "animation"
  | "sticker"

export interface TelegramChatLike {
  id: number
  type: string
  is_forum?: boolean
}

export interface TelegramUserLike {
  id?: number
  username?: string
  first_name?: string
  last_name?: string
}

export interface TelegramReplyLike {
  message_id: number
  text?: string
  caption?: string
}

export interface TelegramPhotoSizeLike {
  file_id: string
  file_unique_id?: string
  file_size?: number
  width?: number
  height?: number
}

export interface TelegramFileLike {
  file_id: string
  file_unique_id?: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

export interface TelegramStickerLike {
  file_id: string
  file_unique_id?: string
  file_size?: number
  is_animated?: boolean
  is_video?: boolean
  emoji?: string
  set_name?: string
}

export interface TelegramMessageLike {
  message_id: number
  media_group_id?: string
  chat: TelegramChatLike
  from?: TelegramUserLike
  text?: string
  caption?: string
  photo?: TelegramPhotoSizeLike[]
  document?: TelegramFileLike
  video?: TelegramFileLike
  audio?: TelegramFileLike
  voice?: TelegramFileLike
  animation?: TelegramFileLike
  sticker?: TelegramStickerLike
  reply_to_message?: TelegramReplyLike
}

export interface TelegramAttachmentRef {
  kind: TelegramAttachmentKind
  fileId: string
  fileUniqueId?: string
  fileSize?: number
  filename?: string
  mime?: string
  messageId: number
}

export interface NormalizedInboundMessage {
  chatId: number
  messageId: number
  messageIds: number[]
  mediaGroupId?: string
  fromUserId?: number
  bodyText: string
  bodySource: "text" | "caption" | "synthetic" | "none"
  attachments: TelegramAttachmentRef[]
  replyToMessageId?: number
  replyToText?: string
}

export interface ResolvedTelegramAttachment {
  kind: TelegramAttachmentKind
  path: string
  mime: string
  filename: string
  telegramFileId: string
  telegramFileUniqueId?: string
  messageId: number
  sizeBytes: number
}
