import { logInfo, logWarn } from "../runtime/logger"
import { GeminiCliError, runGeminiPrompt, type GeminiRunOptions, type GeminiRunResult, type GeminiStreamEvent } from "./client"
import { buildExecutionPrompt, buildPlanPrompt, clearPendingApproval, createApprovalToken, setPendingApproval, type ToolApprovalStrategy } from "./approval"
import { buildPromptFromHistory, formatUserHistoryEntry } from "./prompt"
import { classifyGeminiRequest } from "./request-routing"
import {
  appendChatHistory,
  getChatHistory,
  saveSessions,
  setChatSession,
} from "../store/runtime-state"
import {
  createPlanArtifact,
  setPlanArtifactApprovalMessageId,
  updatePlanArtifact,
} from "../store/plan-artifacts"
import { shouldAlwaysApproveTools } from "../store/tool-approval"
import { pushRewindSnapshot } from "../store/snapshots"
import { renderTodoProgressPlain } from "../telegram/plan-status"
import { sendRenderedAssistantPart } from "../telegram/rendering"
import { buildApprovalPromptMessage, ToolStatusTracker } from "../telegram/tool-status"
import type { ResolvedTelegramAttachment } from "../telegram/types"

type TelegramSendBot = {
  sendMessage: (chatId: number, text: string, options?: Record<string, any>) => Promise<any>
}

export interface GeminiTurnRunnerContext {
  bot: TelegramSendBot
  sendDraft: (chatId: number, draftId: number, text: string) => Promise<void>
  activeResponses: Map<number, AbortController>
  activeDrafts: Map<number, number>
  startTyping: (chatId: number) => void
  stopTyping: (chatId: number) => void
  clearActiveDraft: (chatId: number) => void
  getNativeResumeSession: (chatId: number) => string | undefined
  getEffectiveModel: (chatId: number) => string | undefined
  getExecutionModel: (chatId: number) => string | undefined
  getPlanModel: (chatId: number) => string | undefined
  getToolApprovalStrategy: (chatId: number) => ToolApprovalStrategy
  getResolvedApprovalRuntime: (chatId: number) => {
    strategy: ToolApprovalStrategy
    executionMode: "default" | "yolo"
    sandbox: boolean
  }
  buildCommonGeminiOptions: (
    chatId: number,
    attachments: ResolvedTelegramAttachment[],
    phase: "plan" | "execute" | "direct",
  ) => Omit<GeminiRunOptions, "prompt" | "resume" | "approvalMode" | "signal">
  getRequestIncludeDirectories: (attachments: ResolvedTelegramAttachment[]) => string[]
  setLastResolvedModel: (chatId: number, model: string) => void
  setLastPlanResolvedModel: (chatId: number, model: string) => void
}

function createSnapshotTitle(userText: string, attachments: ResolvedTelegramAttachment[]) {
  const trimmed = userText.trim()
  if (trimmed) return trimmed.slice(0, 40)
  if (attachments[0]?.filename) return `附件：${attachments[0].filename}`.slice(0, 40)
  return "未命名快照"
}

function createDraftId() {
  return Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 100000) + 1
}

function createStreamCallbacks(
  context: GeminiTurnRunnerContext,
  chatId: number,
  draftId: number,
  toolTracker: ToolStatusTracker,
  signal?: AbortSignal,
) {
  let buffer = ""
  let lastDraftText = ""
  let lastDraftAt = 0

  return {
    onRetry: ({ attempt, maxAttempts, delayMs, error }: { attempt: number; maxAttempts: number; delayMs: number; error: Error }) => {
      if (signal?.aborted) return
      logWarn("TG.GEMINI.RETRY", { chatId, attempt, maxAttempts, delayMs, model: context.getEffectiveModel(chatId) }, error.message)
    },
    onEvent: (event: GeminiStreamEvent) => {
      if (signal?.aborted) return
      if (event.type === "tool_use") {
        toolTracker.addToolUse(event.name || event.toolName || "unknown")
      }
      if (event.type === "tool_result") {
        toolTracker.completeToolResult(event.name || event.toolName || "unknown", event.success !== false)
      }
    },
    onChunk: (chunk: string) => {
      if (signal?.aborted) return
      buffer += chunk
      const now = Date.now()
      if (buffer.trim() && buffer !== lastDraftText && now - lastDraftAt > 250) {
        lastDraftText = buffer
        lastDraftAt = now
        void context.sendDraft(chatId, draftId, buffer)
      }
    },
  }
}

export function isGeminiAbortError(error: unknown) {
  return error instanceof Error && error.name === "GeminiCliError" && error.message === "Gemini CLI 已终止"
}

export function preserveGeminiSessionFromError(chatId: number, error: unknown) {
  if (!(error instanceof Error) || error.name !== "GeminiCliError") {
    return false
  }

  const sessionId = (error as GeminiCliError).sessionId
  if (!sessionId) return false

  setChatSession(chatId, sessionId)
  saveSessions()
  return true
}

export function formatGeminiFailureMessage(error: unknown, prefix = "⚠️ Gemini 请求失败：") {
  const details = error instanceof Error ? error.message : String(error)
  const sessionId = error instanceof Error && error.name === "GeminiCliError" ? (error as GeminiCliError).sessionId : undefined
  if (sessionId) {
    return `${prefix}${details}\n\n会话已保留，可直接继续发送下一条消息。`
  }
  return `${prefix}${details}`
}

function logPartialGeminiResponse(
  context: GeminiTurnRunnerContext,
  chatId: number,
  phase: "plan" | "execute" | "direct",
  response: GeminiRunResult,
) {
  if (!response.isPartial) return
  logWarn("TG.GEMINI.PARTIAL_RESPONSE", {
    chatId,
    phase,
    model: response.model || context.getEffectiveModel(chatId),
    sessionId: response.sessionId || "none",
    timedOut: response.timedOut === true,
  }, `partial_chars=${response.text.length}`)
}

async function runPlanPhase(
  context: GeminiTurnRunnerContext,
  chatId: number,
  userText: string,
  attachments: ResolvedTelegramAttachment[],
) {
  const resumeSessionId = context.getNativeResumeSession(chatId)
  const history = resumeSessionId ? [] : getChatHistory(chatId).slice(-10)

  logInfo("TG.GEMINI.PLAN_REQUEST", { chatId, model: context.getPlanModel(chatId), strategy: "plan_then_execute" })

  const planToolTracker = new ToolStatusTracker()
  const draftId = createDraftId()
  context.activeDrafts.set(chatId, draftId)
  const callbacks = createStreamCallbacks(context, chatId, draftId, planToolTracker, context.activeResponses.get(chatId)?.signal)

  const response = await runGeminiPrompt({
    prompt: buildPlanPrompt({ history, userText, attachments }),
    ...context.buildCommonGeminiOptions(chatId, attachments, "plan"),
    resume: resumeSessionId,
    approvalMode: "default",
    signal: context.activeResponses.get(chatId)?.signal,
    ...callbacks,
  })

  if (context.activeResponses.get(chatId)?.signal.aborted) {
    throw new GeminiCliError("Gemini CLI 已终止", { sessionId: response.sessionId, model: response.model })
  }

  await context.sendDraft(chatId, draftId, "").catch(() => { })
  context.activeDrafts.delete(chatId)

  if (response.sessionId) {
    setChatSession(chatId, response.sessionId)
    saveSessions()
  }
  logPartialGeminiResponse(context, chatId, "plan", response)
  if (response.model) {
    context.setLastPlanResolvedModel(chatId, response.model)
    context.setLastResolvedModel(chatId, response.model)
  }

  return {
    ...response,
    toolSummary: planToolTracker.listToolNames(),
  }
}

async function runExecutionPhase(
  context: GeminiTurnRunnerContext,
  chatId: number,
  userText: string,
  planText: string,
  planSessionId: string | undefined,
  attachments: ResolvedTelegramAttachment[],
  planArtifactId?: string,
) {
  const controller = new AbortController()
  context.activeResponses.set(chatId, controller)
  context.startTyping(chatId)

  const toolTracker = new ToolStatusTracker()
  const draftId = createDraftId()
  context.activeDrafts.set(chatId, draftId)
  const callbacks = createStreamCallbacks(context, chatId, draftId, toolTracker, controller.signal)

  logInfo("TG.GEMINI.EXECUTE_REQUEST", { chatId, planSessionId, model: context.getExecutionModel(chatId), strategy: "plan_then_execute" })

  if (planArtifactId) {
    const executingArtifact = updatePlanArtifact(chatId, planArtifactId, { status: "executing" })
    if (executingArtifact) {
      await sendRenderedAssistantPart(context.bot as any, chatId, "status", renderTodoProgressPlain(executingArtifact))
    }
  }

  try {
    const response = await runGeminiPrompt({
      prompt: buildExecutionPrompt({ userText, planText, attachments }),
      ...context.buildCommonGeminiOptions(chatId, attachments, "execute"),
      resume: planSessionId,
      approvalMode: context.getResolvedApprovalRuntime(chatId).executionMode,
      signal: controller.signal,
      ...callbacks,
    })

    if (controller.signal.aborted) {
      return
    }

    if (response.sessionId) {
      setChatSession(chatId, response.sessionId)
      saveSessions()
    }
    logPartialGeminiResponse(context, chatId, "execute", response)
    if (response.model) {
      context.setLastResolvedModel(chatId, response.model)
    }

    appendChatHistory(chatId, {
      role: "assistant",
      text: response.text,
      createdAt: new Date().toISOString(),
    })

    pushRewindSnapshot(chatId, {
      title: createSnapshotTitle(userText, attachments),
      history: getChatHistory(chatId),
      model: context.getEffectiveModel(chatId) || null,
    })

    const completedArtifact = planArtifactId
      ? updatePlanArtifact(chatId, planArtifactId, {
        status: "completed",
        executionSessionId: response.sessionId || null,
        resultSummary: response.text.slice(0, 4000),
      })
      : null

    await context.sendDraft(chatId, draftId, "").catch(() => { })
    context.activeDrafts.delete(chatId)
    if (!toolTracker.isEmpty) {
      await sendRenderedAssistantPart(context.bot as any, chatId, "status", toolTracker.renderPlain())
    }
    if (completedArtifact) {
      await sendRenderedAssistantPart(context.bot as any, chatId, "status", renderTodoProgressPlain(completedArtifact))
    }
    await sendRenderedAssistantPart(context.bot as any, chatId, "text", response.text)
  } catch (error) {
    context.clearActiveDraft(chatId)
    if (planArtifactId) {
      const failedArtifact = updatePlanArtifact(chatId, planArtifactId, {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      if (failedArtifact) {
        await sendRenderedAssistantPart(context.bot as any, chatId, "status", renderTodoProgressPlain(failedArtifact))
      }
    }
    throw error
  } finally {
    context.clearActiveDraft(chatId)
    context.stopTyping(chatId)
    context.activeResponses.delete(chatId)
  }
}

async function handlePrompt(
  context: GeminiTurnRunnerContext,
  chatId: number,
  userText: string,
  attachments: ResolvedTelegramAttachment[],
) {
  const resumeSessionId = context.getNativeResumeSession(chatId)
  const controller = new AbortController()
  context.activeResponses.set(chatId, controller)
  context.startTyping(chatId)
  const history = resumeSessionId ? [] : getChatHistory(chatId).slice(-10)
  const normalizedUserText = formatUserHistoryEntry(userText, attachments)

  appendChatHistory(chatId, {
    role: "user",
    text: normalizedUserText,
    createdAt: new Date().toISOString(),
  })

  const requestRoute = classifyGeminiRequest(userText, attachments)
  logInfo("TG.GEMINI.ROUTE", {
    chatId,
    mode: requestRoute.mode,
    reason: requestRoute.reason,
    strategy: context.getToolApprovalStrategy(chatId),
    attachmentCount: attachments.length,
  })

  if (context.getToolApprovalStrategy(chatId) === "plan_then_execute" && requestRoute.mode === "agent") {
    try {
      const planResponse = await runPlanPhase(context, chatId, userText, attachments)
      context.stopTyping(chatId)
      context.activeResponses.delete(chatId)

      const token = createApprovalToken()
      const toolSummary = planResponse.toolSummary
      const artifact = createPlanArtifact({
        chatId,
        userText,
        planText: planResponse.text,
        toolSummary,
        planModel: context.getPlanModel(chatId) || null,
        executionModel: context.getExecutionModel(chatId) || null,
        planSessionId: planResponse.sessionId,
      })

      setPendingApproval({
        token,
        chatId,
        artifactId: artifact.id,
        planSessionId: planResponse.sessionId,
        userText,
        planText: planResponse.text,
        toolSummary: artifact.toolSummary,
        model: context.getEffectiveModel(chatId),
        includeDirectories: context.getRequestIncludeDirectories(attachments),
        attachments,
        createdAt: Date.now(),
      })

      const approvalMsg = buildApprovalPromptMessage({
        planText: planResponse.text,
        toolSummary,
        token,
        todoSummary: artifact.todos.map((todo) => todo.text),
      })

  if (shouldAlwaysApproveTools(chatId)) {
        clearPendingApproval(chatId)
        await context.bot.sendMessage(chatId, "✅ 当前聊天已设为总是允许，跳过审批，开始执行。").catch(() => { })
        await updatePlanArtifact(chatId, artifact.id, { status: "approved" })
        await runExecutionPhase(context, chatId, userText, planResponse.text, planResponse.sessionId, attachments, artifact.id)
        return
      }

      const sent = await context.bot.sendMessage(chatId, approvalMsg.text, approvalMsg.options).catch(() => null)

      if (sent?.message_id) {
        setPlanArtifactApprovalMessageId(chatId, artifact.id, sent.message_id)
      }

      logInfo("TG.GEMINI.PLAN_AWAITING_APPROVAL", { chatId, token, planSessionId: planResponse.sessionId, artifactId: artifact.id })
      return
    } catch (error) {
      context.clearActiveDraft(chatId)
      context.stopTyping(chatId)
      context.activeResponses.delete(chatId)
      throw error
    }
  }

  const toolTracker = new ToolStatusTracker()
  const draftId = createDraftId()
  context.activeDrafts.set(chatId, draftId)
  const callbacks = createStreamCallbacks(context, chatId, draftId, toolTracker, controller.signal)

  try {
    logInfo("TG.GEMINI.REQUEST", {
      chatId,
      resumeSessionId,
      model: context.getEffectiveModel(chatId),
      attachmentCount: attachments.length,
      attachments: attachments.map((attachment) => ({
        filename: attachment.filename,
        mime: attachment.mime,
        sizeBytes: attachment.sizeBytes,
      })),
    })

    const response = await runGeminiPrompt({
      prompt: buildPromptFromHistory({ history, userText, attachments }),
      ...context.buildCommonGeminiOptions(chatId, attachments, "direct"),
      resume: resumeSessionId,
      approvalMode: "default",
      signal: controller.signal,
      ...callbacks,
    })

    if (controller.signal.aborted) {
      return
    }

    const responseText = response.text
    if (response.sessionId && response.sessionId !== resumeSessionId) {
      setChatSession(chatId, response.sessionId)
      saveSessions()
    }
    logPartialGeminiResponse(context, chatId, "direct", response)
    if (response.model) {
      context.setLastResolvedModel(chatId, response.model)
    }

    appendChatHistory(chatId, {
      role: "assistant",
      text: responseText,
      createdAt: new Date().toISOString(),
    })

    pushRewindSnapshot(chatId, {
      title: createSnapshotTitle(userText, attachments),
      history: getChatHistory(chatId),
      model: context.getEffectiveModel(chatId) || null,
    })

    await context.sendDraft(chatId, draftId, "").catch(() => { })
    context.activeDrafts.delete(chatId)
    if (!toolTracker.isEmpty) {
      await sendRenderedAssistantPart(context.bot as any, chatId, "status", toolTracker.renderPlain())
    }
    await sendRenderedAssistantPart(context.bot as any, chatId, "text", responseText)
  } finally {
    context.clearActiveDraft(chatId)
    context.stopTyping(chatId)
    context.activeResponses.delete(chatId)
  }
}

export function createGeminiTurnRunner(context: GeminiTurnRunnerContext) {
  return {
    handlePrompt: (chatId: number, userText: string, attachments: ResolvedTelegramAttachment[]) =>
      handlePrompt(context, chatId, userText, attachments),
    runExecutionPhase: (
      chatId: number,
      userText: string,
      planText: string,
      planSessionId: string | undefined,
      attachments: ResolvedTelegramAttachment[],
      planArtifactId?: string,
    ) => runExecutionPhase(context, chatId, userText, planText, planSessionId, attachments, planArtifactId),
  }
}
