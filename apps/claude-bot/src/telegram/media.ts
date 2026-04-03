export {
  DEFAULT_MEDIA_CACHE_TTL_MS,
  DEFAULT_MEDIA_CLEANUP_DELAY_MS,
  TELEGRAM_DOWNLOAD_LIMIT_BYTES,
  TelegramMediaError,
  cleanupExpiredMediaCache,
  resolveTelegramAttachments,
  resolveUniqueTargetPath,
  scheduleAttachmentCleanup,
  startMediaCacheJanitor,
} from "@matincz/telegram-bot-core/telegram/media"
import { getMediaCacheRoot as getSharedMediaCacheRoot } from "@matincz/telegram-bot-core/telegram/media"

export function getMediaCacheRoot(rootDir?: string) {
  return getSharedMediaCacheRoot(rootDir)
}
