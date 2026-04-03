type TelegramCallbackBot = {
  answerCallbackQuery: (callbackQueryId: string, options?: Record<string, any>) => Promise<any>
  editMessageText: (text: string, options: Record<string, any>) => Promise<any>
}

export async function answerCallbackQuerySafe(
  bot: TelegramCallbackBot,
  queryId: string,
  options?: string | Record<string, any>,
) {
  const payload = typeof options === "string" ? { text: options } : options
  return bot.answerCallbackQuery(queryId, payload as any)
    .then(() => true)
    .catch(() => false)
}

export async function editMessageTextSafe(
  bot: TelegramCallbackBot,
  chatId: number,
  messageId: number,
  text: string,
  options?: Record<string, any>,
) {
  return bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    ...(options || {}),
  } as any)
    .then(() => true)
    .catch(() => false)
}
