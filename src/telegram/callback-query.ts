import * as fs from "fs"
import { exec } from "child_process"
import TelegramBot from "node-telegram-bot-api"
import {
  chatAwaitingQuestionInput,
  clearActiveProjectSelection,
  clearChatSession,
  pendingQuestionRequests,
  saveSelectedModels,
  saveSessions,
  selectedModelMap,
  sessionMap,
  setActiveProjectSelection,
  setChatSession,
} from "../store/runtime-state"
import type { PermissionRequestMap, QuestionActionMap } from "./interactive-requests"

type CallbackPayloadMap = Map<string, { type: string; value: string }>

export interface TelegramCallbackQueryContext {
  bot: TelegramBot
  callbackPayloadMap: CallbackPayloadMap
  permRequestMap: PermissionRequestMap
  questionActionMap: QuestionActionMap
  buildProjectScopedHeaders: (input: { chatId: number }) => Promise<HeadersInit>
  fetchWithOpencodeTimeout: (path: string, init: RequestInit) => Promise<Response>
  replyToQuestion: (chatId: number, requestId: string, answers: string[][]) => Promise<void>
  finalizeQuestionPrompt: (chatId: number, requestId: string, footer: string) => Promise<void>
  startTypingIndicator: (chatId: number) => Promise<void>
  rejectQuestion: (chatId: number, requestId: string) => Promise<void>
  disposeChatState: (chatId: number) => void
  opencodeGet: (path: string, chatId?: number, scoped?: boolean) => Promise<any>
  opencodePost: (path: string, body?: any, chatId?: number, scoped?: boolean) => Promise<any>
  getProjectDisplayName: (worktree: string) => string
  isOverlyBroadProjectWorktree: (worktree?: string) => boolean
  escapeHtml: (value: string) => string
  getModelMenuContext: (chatId: number) => Promise<{ providers: any[]; currentModel: string }>
  getProviderDisplayName: (provider: any) => string
  createCallbackToken: (type: string, value: string) => string
  parseModelRef: (model: string) => { providerID: string; modelID: string } | undefined
}

async function answer(bot: TelegramBot, queryId: string, text?: string) {
  await bot.answerCallbackQuery(queryId, text ? { text } : undefined as any).catch(() => { })
}

async function editMessageTextSafe(
  bot: TelegramBot,
  chatId: number,
  messageId: number,
  text: string,
  options?: { parse_mode?: "HTML"; reply_markup?: any },
) {
  await bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    ...(options || {}),
  } as any).catch(() => { })
}

function triggerProjectDeepLink(worktree: string) {
  try {
    const link = `opencode://open-project?directory=${encodeURIComponent(worktree)}`
    const cmd =
      process.platform === "darwin"
        ? `open -a OpenCode "${link}"`
        : process.platform === "win32"
          ? `start "" "${link}"`
          : `xdg-open "${link}"`

    console.log(`[DeepLink] 发送指令切换 UI 项: ${cmd}`)
    fs.appendFileSync("UI_JUMP_DEBUG.log", `[${new Date().toISOString()}] Executing: ${cmd}\n`)

    exec(cmd, (error: any, _stdout: string, stderr: string) => {
      if (error) {
        console.error("[DeepLink] 触发 OpenCode UI 失败: ", error.message)
        fs.appendFileSync("UI_JUMP_DEBUG.log", `[${new Date().toISOString()}] ERROR: ${error.message}\n`)
      }
      if (stderr) {
        console.error("[DeepLink] 触发 OpenCode UI 警告: ", stderr)
        fs.appendFileSync("UI_JUMP_DEBUG.log", `[${new Date().toISOString()}] STDERR: ${stderr}\n`)
      }
      if (!error && !stderr) {
        fs.appendFileSync("UI_JUMP_DEBUG.log", `[${new Date().toISOString()}] SUCCESS\n`)
      }
    })
  } catch (error: any) {
    console.error("Failed to trigger OpenCode UI jump:", error.message)
  }
}

export async function handleTelegramCallbackQuery(
  query: any,
  context: TelegramCallbackQueryContext,
) {
  const data: string = query.data || ""
  const chatId: number | undefined = query.message?.chat?.id
  const messageId: number | undefined = query.message?.message_id
  if (!chatId || !messageId) {
    await answer(context.bot, query.id)
    return
  }

  if (data === "noop") {
    await answer(context.bot, query.id)
    return
  }

  if (data.startsWith("prm:")) {
    const parts = data.split(":")
    const response = parts[1]
    const reqToken = parts.slice(2).join(":")
    const reqInfo = context.permRequestMap.get(reqToken)

    if (!reqInfo) {
      await answer(context.bot, query.id, "❌ 审批请求已过期")
      return
    }

    try {
      const scopedHeaders = await context.buildProjectScopedHeaders({ chatId })
      await context.fetchWithOpencodeTimeout(`/permission/${reqInfo.permId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...scopedHeaders },
        body: JSON.stringify({ reply: response }),
      })

      const label =
        response === "once" ? "✅ 已允许（本次）" : response === "always" ? "✅ 已允许（总是）" : "❌ 已拒绝"

      await editMessageTextSafe(
        context.bot,
        chatId,
        messageId,
        `${query.message.text}\n\n${label}`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } },
      )
    } catch {
      await answer(context.bot, query.id, "❌ 操作失败")
      return
    }

    await answer(context.bot, query.id)
    return
  }

  if (data.startsWith("q:")) {
    const token = data.slice(2)
    const action = context.questionActionMap.get(token)
    if (!action) {
      await answer(context.bot, query.id, "❌ 问题已过期，请重新触发")
      return
    }
    context.questionActionMap.delete(token)

    try {
      if (action.type === "reply") {
        await context.replyToQuestion(chatId, action.requestId, action.answers)
        await context.finalizeQuestionPrompt(
          chatId,
          action.requestId,
          `✅ 已回答：<code>${context.escapeHtml(action.answers[0]?.join(", ") || "")}</code>`,
        )
        await context.startTypingIndicator(chatId)
      }

      if (action.type === "custom") {
        const state = pendingQuestionRequests.get(action.requestId)
        if (!state) {
          await answer(context.bot, query.id, "❌ 问题已过期，请重新触发")
          return
        }
        chatAwaitingQuestionInput.set(chatId, {
          requestId: action.requestId,
          sessionId: state.sessionId,
        })
        await context.bot
          .sendMessage(chatId, "✍️ 请直接发送一条文字消息作为这个问题的回答。\n如果想放弃本次提问，可发送 /stop。")
          .catch(() => { })
      }

      if (action.type === "reject") {
        await context.rejectQuestion(chatId, action.requestId)
        await context.finalizeQuestionPrompt(chatId, action.requestId, "❌ 已拒绝")
      }
    } catch (error) {
      console.error("[QUESTION_CALLBACK_ERROR]", error)
      await answer(context.bot, query.id, "❌ 问题处理失败")
      return
    }

    await answer(context.bot, query.id)
    return
  }

  if (data.startsWith("session:")) {
    const payload = context.callbackPayloadMap.get(data)
    const newSessionId = payload?.type === "session" ? payload.value : undefined
    if (!newSessionId) {
      await answer(context.bot, query.id, "❌ 会话信息已过期，请重新获取")
      return
    }

    setChatSession(chatId, newSessionId)
    context.disposeChatState(chatId)
    saveSessions()

    const sessionDetail = await context.opencodeGet(`/session/${newSessionId}`, chatId).catch(() => null)
    const sessionTitle = sessionDetail?.title || newSessionId
    await editMessageTextSafe(
      context.bot,
      chatId,
      messageId,
      `✅ 已切换到会话 <b>${context.escapeHtml(sessionTitle)}</b>\n<code>${newSessionId}</code>`,
      { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } },
    )
    await answer(context.bot, query.id)
    return
  }

  if (data.startsWith("project:")) {
    const payload = context.callbackPayloadMap.get(data)
    if (!payload || payload.type !== "project") {
      await answer(context.bot, query.id, "❌ 项目信息已过期，请重新获取")
      return
    }

    const newProjectId = payload.value
    const projects: any[] = await context.opencodeGet("/project").catch(() => [])
    const nextProject = newProjectId === "__current__" ? undefined : projects.find((p: any) => p.id === newProjectId)

    if (
      newProjectId !== "__current__" &&
      (!nextProject || nextProject.id === "global" || context.isOverlyBroadProjectWorktree(nextProject.worktree))
    ) {
      await answer(context.bot, query.id, "❌ 该项目范围过大，请选择更具体的仓库目录")
      return
    }

    let confirmText: string
    if (newProjectId === "__current__") {
      clearActiveProjectSelection(chatId)
      context.disposeChatState(chatId)
      clearChatSession(chatId)
      saveSessions()
      confirmText = "♻️ 已清除 Telegram 项目选择。\n下一条消息将跟随后端默认目录重新创建会话。"
    } else {
      const worktree = nextProject?.worktree || newProjectId
      setActiveProjectSelection(chatId, newProjectId, worktree)
      context.disposeChatState(chatId)
      clearChatSession(chatId)
      saveSessions()

      confirmText =
        `✅ 已切换到项目 <b>${context.escapeHtml(context.getProjectDisplayName(worktree))}</b>\n` +
        `<code>${context.escapeHtml(worktree)}</code>\n\n` +
        `下次发消息会在该项目下创建或继续会话。`

      if (worktree) triggerProjectDeepLink(worktree)
    }

    await editMessageTextSafe(context.bot, chatId, messageId, confirmText, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    })
    await answer(context.bot, query.id)
    return
  }

  if (data === "p:back") {
    try {
      const { providers, currentModel } = await context.getModelMenuContext(chatId)
      const keyboard: any[][] = []
      let totalProviders = 0
      let currentRow: any[] = []

      for (const provider of providers) {
        if (!provider.models || Object.keys(provider.models).length === 0) continue
        if (totalProviders >= 50) break

        currentRow.push({ text: context.getProviderDisplayName(provider), callback_data: context.createCallbackToken("provider", provider.id) })
        totalProviders++
        if (currentRow.length === 2) {
          keyboard.push(currentRow)
          currentRow = []
        }
      }
      if (currentRow.length > 0) keyboard.push(currentRow)

      const header = `🤖 <b>选择模型供应商</b>${currentModel ? `\n(当前使用: <code>${context.escapeHtml(currentModel)}</code>)` : ""}:`
      await editMessageTextSafe(context.bot, chatId, messageId, header, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard },
      })
    } catch {
      await answer(context.bot, query.id, "❌ 获取列表失败")
      return
    }

    await answer(context.bot, query.id)
    return
  }

  if (data.startsWith("provider:")) {
    const payload = context.callbackPayloadMap.get(data)
    const providerId = payload?.type === "provider" ? payload.value : undefined
    if (!providerId) {
      await answer(context.bot, query.id, "❌ 供应商信息已过期，请重新获取")
      return
    }

    try {
      const { providers, currentModel } = await context.getModelMenuContext(chatId)
      const provider = providers.find((item) => item.id === providerId)
      if (!provider || !provider.models) {
        await answer(context.bot, query.id, "❌ 该供应商下无模型")
        return
      }

      const keyboard: any[][] = []
      const modelsObj: Record<string, any> = provider.models
      let totalModels = 0

      for (const modelKey of Object.keys(modelsObj)) {
        if (totalModels >= 80) break
        const fullId = `${provider.id}/${modelKey}`
        const modelInfo = modelsObj[modelKey] || {}
        const displayName = modelInfo?.name || modelKey
        const isCurrent = currentModel === fullId || currentModel.endsWith(`/${modelKey}`)
        const label = `${isCurrent ? "✅ " : ""}${displayName}`
        keyboard.push([{ text: label, callback_data: context.createCallbackToken("model", fullId) }])
        totalModels++
      }

      keyboard.push([{ text: "🔙 返回供应商列表", callback_data: "p:back" }])

      const header =
        `🤖 <b>选择 ${context.escapeHtml(context.getProviderDisplayName(provider))} 的模型</b>` +
        `${currentModel ? `\n(当前: <code>${context.escapeHtml(currentModel)}</code>)` : ""}:`

      await editMessageTextSafe(context.bot, chatId, messageId, header, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard },
      })
    } catch {
      await answer(context.bot, query.id, "❌ 获取模型失败")
      return
    }

    await answer(context.bot, query.id)
    return
  }

  if (data.startsWith("model:")) {
    const payload = context.callbackPayloadMap.get(data)
    const modelId = payload?.type === "model" ? payload.value : undefined
    if (!modelId) {
      await answer(context.bot, query.id, "❌ 模型信息已过期，请重新获取")
      return
    }

    try {
      selectedModelMap.set(chatId, modelId)
      saveSelectedModels()
      await editMessageTextSafe(
        context.bot,
        chatId,
        messageId,
        `✅ 已切换到模型 <code>${context.escapeHtml(modelId)}</code>`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } },
      )
    } catch {
      await answer(context.bot, query.id, "❌ 切换模型失败")
      return
    }

    await answer(context.bot, query.id)
    return
  }

  if (data.startsWith("command:")) {
    const payload = context.callbackPayloadMap.get(data)
    const cmdName = payload?.type === "command" ? payload.value : undefined
    const sessionId = sessionMap.get(chatId)
    if (!cmdName || !sessionId) {
      await answer(context.bot, query.id, "❌ 当前无会话")
      return
    }

    try {
      const selectedModel = selectedModelMap.get(chatId)
      await context.opencodePost(
        `/session/${sessionId}/command`,
        {
          model: selectedModel ? context.parseModelRef(selectedModel) : undefined,
          command: `/${cmdName}`,
          arguments: "",
        },
        chatId,
        true,
      )
      await editMessageTextSafe(
        context.bot,
        chatId,
        messageId,
        `✅ 已执行命令 <code>/${cmdName}</code>`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } },
      )
    } catch {
      await answer(context.bot, query.id, "❌ 命令执行失败")
      return
    }

    await answer(context.bot, query.id)
    return
  }

  await answer(context.bot, query.id)
}
