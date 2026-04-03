export {
  escapeHtml,
  extractSessionErrorMessage,
  markdownToTelegramHtml,
  sendRenderedAssistantPart,
} from "@matincz/telegram-bot-core/telegram/rendering"
import {
  buildSessionErrorNotice as buildSharedSessionErrorNotice,
  createDraftSender as createSharedDraftSender,
} from "@matincz/telegram-bot-core/telegram/rendering"

export function createDraftSender(tgApiBase: string) {
  return createSharedDraftSender({
    tgApiBase,
    emptyTextBehavior: "zero_width_space",
  })
}

export function buildSessionErrorNotice(rawMessage?: string) {
  return buildSharedSessionErrorNotice({
    rawMessage,
    noDetailsText: "OpenCode 没有返回更具体的错误信息。",
  })
}
