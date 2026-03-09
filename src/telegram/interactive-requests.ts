import TelegramBot from "node-telegram-bot-api"
import { clearQuestionState, pendingQuestionRequests } from "../store/runtime-state"
import {
  renderPermissionRequestText,
  renderQuestionRequestText,
  UNSUPPORTED_QUESTION_NOTICE,
} from "./interactive-prompts"

export type PermissionRequestMap = Map<string, { sessionId: string; permId: string }>

export type QuestionActionMap = Map<
  string,
  | { type: "reply"; requestId: string; answers: string[][] }
  | { type: "custom"; requestId: string }
  | { type: "reject"; requestId: string }
>

export interface TelegramInteractiveRequestsContext {
  bot: TelegramBot
  permRequestMap: PermissionRequestMap
  questionActionMap: QuestionActionMap
  createCallbackToken: (type: string, value: string) => string
  buildProjectScopedHeaders: (input?: { chatId?: number; worktree?: string }) => Promise<HeadersInit>
  fetchWithOpencodeTimeout: (path: string, init: RequestInit) => Promise<Response>
  escapeHtml: (value: string) => string
  stopTypingIndicator: (chatId: number) => void
}

export function createTelegramInteractiveRequests(context: TelegramInteractiveRequestsContext) {
  async function sendPermissionRequestPrompt(chatId: number, perm: any) {
    const permSessionId = perm?.sessionID
    const permId = perm?.id
    if (!permSessionId || !permId) return

    const reqToken = context.createCallbackToken("perm", permId)
    context.permRequestMap.set(reqToken, { sessionId: permSessionId, permId })

    await context.bot.sendMessage(chatId, renderPermissionRequestText(perm, context.escapeHtml), {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ 允许一次", callback_data: `prm:once:${reqToken}` },
          { text: "✅✅ 总是允许", callback_data: `prm:always:${reqToken}` },
          { text: "❌ 拒绝", callback_data: `prm:reject:${reqToken}` },
        ]],
      },
    } as any).catch((error: any) => {
      console.error("[PERM_SEND_ERROR]", error.message)
    })
  }

  async function replyToQuestion(chatId: number, requestId: string, answers: string[][]) {
    const scopedHeaders = await context.buildProjectScopedHeaders({ chatId })
    await context.fetchWithOpencodeTimeout(`/question/${requestId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...scopedHeaders },
      body: JSON.stringify({ answers }),
    })
  }

  async function rejectQuestion(chatId: number, requestId: string) {
    const scopedHeaders = await context.buildProjectScopedHeaders({ chatId })
    await context.fetchWithOpencodeTimeout(`/question/${requestId}/reject`, {
      method: "POST",
      headers: scopedHeaders,
    })
  }

  async function finalizeQuestionPrompt(chatId: number, requestId: string, footer: string) {
    const state = pendingQuestionRequests.get(requestId)
    if (!state?.messageId) {
      clearQuestionState(chatId, requestId)
      return
    }

    await context.bot.editMessageText(`${state.text}\n\n${footer}`, {
      chat_id: chatId,
      message_id: state.messageId,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    } as any).catch(() => { })

    clearQuestionState(chatId, requestId)
  }

  async function sendQuestionRequestPrompt(chatId: number, request: any) {
    const requestId = request?.id
    const sessionId = request?.sessionID
    const questions = Array.isArray(request?.questions) ? request.questions : []
    if (!requestId || !sessionId || questions.length === 0) return
    if (pendingQuestionRequests.has(requestId)) return

    const text = renderQuestionRequestText(request, context.escapeHtml)
    const single = questions.length === 1 ? questions[0] : undefined
    const supportsInlineReply = !!single && single?.multiple !== true
    const inlineKeyboard: any[][] = []

    if (supportsInlineReply) {
      for (const option of single.options || []) {
        const token = context.createCallbackToken("question-action", requestId)
        context.questionActionMap.set(token, {
          type: "reply",
          requestId,
          answers: [[String(option.label)]],
        })
        inlineKeyboard.push([{ text: String(option.label), callback_data: `q:${token}` }])
      }

      if (single.custom !== false) {
        const customToken = context.createCallbackToken("question-action", requestId)
        context.questionActionMap.set(customToken, { type: "custom", requestId })
        inlineKeyboard.push([{ text: "✍️ 自定义回答", callback_data: `q:${customToken}` }])
      }
    }

    const rejectToken = context.createCallbackToken("question-action", requestId)
    context.questionActionMap.set(rejectToken, { type: "reject", requestId })
    inlineKeyboard.push([{ text: "❌ 拒绝", callback_data: `q:${rejectToken}` }])

    if (!supportsInlineReply) {
      inlineKeyboard.unshift([{ text: "ℹ️ 请在桌面端处理", callback_data: "noop" }])
    }

    context.stopTypingIndicator(chatId)

    const sent = await context.bot.sendMessage(
      chatId,
      supportsInlineReply ? text : `${text}\n\n${UNSUPPORTED_QUESTION_NOTICE}`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: inlineKeyboard },
      } as any,
    ).catch((error: any) => {
      console.error("[QUESTION_SEND_ERROR]", error?.message || error)
      return null
    })

    pendingQuestionRequests.set(requestId, {
      chatId,
      sessionId,
      text,
      messageId: sent?.message_id,
    })
  }

  return {
    sendPermissionRequestPrompt,
    replyToQuestion,
    rejectQuestion,
    finalizeQuestionPrompt,
    sendQuestionRequestPrompt,
  }
}
