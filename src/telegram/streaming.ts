import TelegramBot from "node-telegram-bot-api"
import { sendSessionCommand, sendSessionPromptAsync, type ModelRef } from "../opencode/client"
import { buildCommandFileParts, buildPromptParts } from "../opencode/parts"
import { clearQuestionState, getChatIdForSession } from "../store/runtime-state"
import { TelegramMediaError } from "./media"
import { ResolvedTelegramAttachment, type NormalizedInboundMessage } from "./types"
import {
  buildSessionErrorNotice,
  createDraftSender,
  extractSessionErrorMessage,
  sendRenderedAssistantPart,
} from "./rendering"

class Bubble {
  readonly draftId: number
  text = ""
  done = false
  lastDraftText = ""

  constructor(
    readonly id: string,
    public partType: string,
  ) {
    this.draftId = Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 100000) + 1
  }
}

interface ChatState {
  bubbles: Map<string, Bubble>
  bubbleOrder: string[]
  processing: boolean
  typingTimer: ReturnType<typeof setInterval> | null
  responseNonce: number
  responseMode: "sse" | "poll" | null
  responseSessionId?: string
  responseAbortController: AbortController | null
}

interface TrackedResponseStream {
  ready: Promise<void>
  task: Promise<void>
}

export interface TelegramStreamingContext {
  bot: TelegramBot
  tgApiBase: string
  opencodeRequestTimeoutMs: number
  opencodeResponsePollIntervalMs: number
  opencodeResponsePollTimeoutMs: number
  opencodeResponsePollMessageLimit: number
  resolveOpencodeBackend: (
    input?: { forceRefresh?: boolean },
  ) => Promise<{ baseUrl: string; headers: Record<string, string>; source: string }>
  fetchWithOpencodeTimeout: (path: string, init: RequestInit) => Promise<Response>
  opencodeGet: (path: string, chatId?: number, scoped?: boolean) => Promise<any>
  ensureSession: (chatId: number) => Promise<string>
  getActiveProjectWorktree: (chatId: number) => Promise<string | undefined>
  buildProjectScopedHeaders: (input?: { chatId?: number; worktree?: string }) => Promise<HeadersInit>
  isOverlyBroadProjectWorktree: (worktree?: string) => boolean
  resolveInboundAttachments: (normalized: NormalizedInboundMessage) => Promise<ResolvedTelegramAttachment[]>
  scheduleAttachmentCleanup: (paths: string[], delayMs?: number) => void
  resolveSelectedAgent: (chatId: number) => string | undefined
  resolveSelectedModel: (chatId: number) => ModelRef | undefined
  resolveEffectiveModelInfo: (chatId: number) => Promise<any>
  sendPermissionRequestPrompt: (chatId: number, perm: any) => Promise<void>
  sendQuestionRequestPrompt: (chatId: number, request: any) => Promise<void>
}

export function formatUserFacingError(error: unknown) {
  if (error instanceof TelegramMediaError) return error.message
  if (error instanceof Error) return error.message
  return "未知错误"
}

export function createTelegramStreaming(context: TelegramStreamingContext) {
  const sendDraft = createDraftSender(context.tgApiBase)
  const chatStates = new Map<number, ChatState>()
  const pendingUserTexts = new Map<string, string>()
  function getChatState(chatId: number): ChatState {
    if (!chatStates.has(chatId)) {
      chatStates.set(chatId, {
        bubbles: new Map(),
        bubbleOrder: [],
        processing: false,
        typingTimer: null,
        responseNonce: 0,
        responseMode: null,
        responseAbortController: null,
      })
    }
    return chatStates.get(chatId)!
  }

  function resetChatStreamState(chatId: number) {
    const state = getChatState(chatId)
    state.bubbleOrder = []
    state.bubbles.clear()
    return state
  }

  function clearResponseTracking(chatId: number) {
    const state = chatStates.get(chatId)
    if (!state) return
    if (state.responseAbortController) {
      state.responseAbortController.abort()
      state.responseAbortController = null
    }
    state.responseNonce += 1
    state.responseMode = null
    state.responseSessionId = undefined
  }

  function hasActiveResponse(chatId: number) {
    const state = chatStates.get(chatId)
    return !!state && state.responseMode !== null
  }

  function clearDrafts(chatId: number) {
    const state = chatStates.get(chatId)
    if (!state) {
      void sendDraft(chatId, 9999, "")
      return
    }
    for (const bubble of state.bubbles.values()) {
      void sendDraft(chatId, bubble.draftId, "")
    }
    void sendDraft(chatId, 9999, "")
  }

  function stopTypingIndicator(chatId: number) {
    const state = getChatState(chatId)
    if (state.typingTimer) {
      clearInterval(state.typingTimer)
      state.typingTimer = null
    }
  }

  async function startTypingIndicator(chatId: number) {
    stopTypingIndicator(chatId)
    const state = getChatState(chatId)
    await context.bot.sendChatAction(chatId, "typing").catch(() => { })
    state.typingTimer = setInterval(async () => {
      await context.bot.sendChatAction(chatId, "typing").catch(() => { })
    }, 4000)
  }

  function disposeChatState(chatId: number) {
    const state = chatStates.get(chatId)
    clearQuestionState(chatId)
    if (!state) return
    stopTypingIndicator(chatId)
    if (state.responseAbortController) {
      state.responseAbortController.abort()
      state.responseAbortController = null
    }
    state.processing = false
    state.bubbles.clear()
    state.bubbleOrder = []
    state.responseNonce += 1
    state.responseMode = null
    state.responseSessionId = undefined
    chatStates.delete(chatId)
  }

  function beginTrackedResponse(chatId: number, sessionId: string, mode: "sse" | "poll") {
    const state = getChatState(chatId)
    if (state.responseAbortController) {
      state.responseAbortController.abort()
      state.responseAbortController = null
    }
    state.responseNonce += 1
    state.responseMode = mode
    state.responseSessionId = sessionId
    return state.responseNonce
  }

  function isTrackedResponseActive(chatId: number, sessionId: string, nonce: number) {
    const state = chatStates.get(chatId)
    return !!state && state.responseNonce === nonce && state.responseSessionId === sessionId
  }

  function attachResponseAbortController(chatId: number, controller: AbortController) {
    const state = getChatState(chatId)
    if (state.responseAbortController && state.responseAbortController !== controller) {
      state.responseAbortController.abort()
    }
    state.responseAbortController = controller
  }

  async function handleResponseError(chatId: number, sessionId: string, nonce: number, error: unknown) {
    if (!isTrackedResponseActive(chatId, sessionId, nonce)) return
    pendingUserTexts.delete(sessionId)
    stopTypingIndicator(chatId)
    clearResponseTracking(chatId)
    clearDrafts(chatId)
    await context.bot.sendMessage(chatId, `⚠️ 错误: ${formatUserFacingError(error)}`).catch(() => { })
  }

  function extractRenderableAssistantParts(message: any) {
    const rendered: Array<{ partType: string; text: string }> = []
    for (const part of Array.isArray(message?.parts) ? message.parts : []) {
      if (part?.type !== "reasoning" && part?.type !== "text") continue
      const text =
        part.type === "reasoning"
          ? String(part?.reasoning || part?.text || "")
          : String(part?.text || "")
      if (!text.trim()) continue
      rendered.push({ partType: part.type, text })
    }
    return rendered
  }

  function syncPolledAssistantMessage(chatId: number, message: any) {
    const state = getChatState(chatId)
    const renderableParts = extractRenderableAssistantParts(message)
    let hasText = false
    let allRenderableDone = renderableParts.length > 0

    for (const rawPart of Array.isArray(message?.parts) ? message.parts : []) {
      if (rawPart?.type !== "reasoning" && rawPart?.type !== "text") continue

      const text =
        rawPart.type === "reasoning"
          ? String(rawPart?.reasoning || rawPart?.text || "")
          : String(rawPart?.text || "")

      const trimmed = text.trim()
      const partDone = Boolean(rawPart?.time?.end || message?.info?.time?.completed)

      if (rawPart.type === "text" && trimmed) hasText = true
      if (!partDone) allRenderableDone = false
      if (!trimmed) continue

      let bubble = state.bubbles.get(rawPart.id)
      if (!bubble) {
        bubble = new Bubble(rawPart.id, rawPart.type)
        state.bubbles.set(rawPart.id, bubble)
        state.bubbleOrder.push(rawPart.id)
        void triggerWorker(chatId)
      }

      bubble.partType = rawPart.type
      bubble.text = text
      if (partDone) bubble.done = true
    }

    return {
      hasRenderableParts: renderableParts.length > 0,
      hasText,
      completed: Boolean(message?.info?.time?.completed),
      allRenderableDone,
    }
  }

  async function captureKnownAssistantMessageIds(chatId: number, sessionId: string) {
    const messages = await context.opencodeGet(
      `/session/${sessionId}/message?limit=${context.opencodeResponsePollMessageLimit}`,
      chatId,
      true,
    ).catch(() => [] as any[])

    return new Set(
      (Array.isArray(messages) ? messages : [])
        .filter((message: any) => message?.info?.role === "assistant" && typeof message?.info?.id === "string")
        .map((message: any) => message.info.id),
    )
  }

  async function pollSessionResponse(
    chatId: number,
    sessionId: string,
    nonce: number,
    initialAssistantMessageIds: Iterable<string>,
  ) {
    const seenAssistantMessageIds = new Set(initialAssistantMessageIds)
    const announcedPermissionIds = new Set<string>()
    const startedAt = Date.now()

    while (Date.now() - startedAt < context.opencodeResponsePollTimeoutMs) {
      if (!isTrackedResponseActive(chatId, sessionId, nonce)) return

      const [messages, permissions] = await Promise.all([
        context.opencodeGet(
          `/session/${sessionId}/message?limit=${context.opencodeResponsePollMessageLimit}`,
          chatId,
          true,
        ).catch(() => [] as any[]),
        context.opencodeGet("/permission", chatId, true).catch(() => [] as any[]),
      ])

      if (!isTrackedResponseActive(chatId, sessionId, nonce)) return

      const pendingPermissions = (Array.isArray(permissions) ? permissions : []).filter(
        (item: any) => item?.sessionID === sessionId,
      )

      for (const perm of pendingPermissions) {
        if (typeof perm?.id !== "string" || announcedPermissionIds.has(perm.id)) continue
        announcedPermissionIds.add(perm.id)
        await context.sendPermissionRequestPrompt(chatId, perm)
      }

      const newAssistantMessages = (Array.isArray(messages) ? messages : [])
        .filter((message: any) => message?.info?.role === "assistant" && typeof message?.info?.id === "string")
        .filter((message: any) => !seenAssistantMessageIds.has(message.info.id))
        .sort((a: any, b: any) => Number(a?.info?.time?.created || 0) - Number(b?.info?.time?.created || 0))

      for (const message of newAssistantMessages) {
        const synced = syncPolledAssistantMessage(chatId, message)
        if (!synced.completed && !synced.hasRenderableParts) continue

        console.log(`[POLL_REPLY] chat=${chatId} session=${sessionId} message=${message.info.id} hasText=${synced.hasText}`)

        if (synced.completed && synced.hasRenderableParts && synced.allRenderableDone) {
          seenAssistantMessageIds.add(message.info.id)
        }

        if (!synced.completed || !synced.hasText) continue

        pendingUserTexts.delete(sessionId)
        stopTypingIndicator(chatId)
        clearResponseTracking(chatId)
        clearDrafts(chatId)
        return
      }

      await new Promise((resolve) => setTimeout(resolve, context.opencodeResponsePollIntervalMs))
    }

    if (!isTrackedResponseActive(chatId, sessionId, nonce)) return

    pendingUserTexts.delete(sessionId)
    stopTypingIndicator(chatId)
    clearResponseTracking(chatId)
    clearDrafts(chatId)
    await context.bot.sendMessage(chatId, "⚠️ 当前响应等待超时，请稍后重试，或发送 /stop 后重新开始。").catch(() => { })
  }

  async function openScopedEventStream(worktree: string, signal: AbortSignal) {
    const backend = await context.resolveOpencodeBackend({ forceRefresh: true })
    const headers = new Headers({ "x-opencode-directory": worktree })

    for (const [key, value] of Object.entries(backend.headers)) {
      if (!headers.has(key)) headers.set(key, value)
    }

    const controller = new AbortController()
    const relayAbort = () => controller.abort()
    signal.addEventListener("abort", relayAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), context.opencodeRequestTimeoutMs)

    try {
      const response = await fetch(`${backend.baseUrl}/event`, {
        headers,
        signal: controller.signal,
      })

      if (!response.ok) throw new Error(`SSE 订阅失败 (${response.status})`)
      if (!response.body) throw new Error("SSE 订阅失败：/event 没有返回 body")
      return response
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", relayAbort)
    }
  }

  function createScopedSessionResponseStream(
    chatId: number,
    sessionId: string,
    nonce: number,
    worktree: string,
  ): TrackedResponseStream {
    const processedPartIds = new Set<string>()
    const deltaBuf = new Map<string, string>()
    const controller = new AbortController()
    attachResponseAbortController(chatId, controller)

    let readySettled = false
    let resolveReady!: () => void
    let rejectReady!: (reason?: unknown) => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })

    const settleReady = (fn: () => void) => {
      if (readySettled) return
      readySettled = true
      fn()
    }

    const task = (async () => {
      let lastToolDraftAt = 0

      while (isTrackedResponseActive(chatId, sessionId, nonce)) {
        try {
          const response = await openScopedEventStream(worktree, controller.signal)
          settleReady(resolveReady)
          console.log(`[SSE_SCOPED] 已连接 chat=${chatId} session=${sessionId} worktree=${worktree}`)

          const reader = response.body!.getReader()
          const decoder = new TextDecoder()
          let buffer = ""

          while (isTrackedResponseActive(chatId, sessionId, nonce)) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const chunks = buffer.split("\n\n")
            buffer = chunks.pop() || ""

            for (const chunk of chunks) {
              if (!chunk.startsWith("data: ")) continue

              try {
                const parsed = JSON.parse(chunk.slice(6))
                if (!parsed) continue

                const payload = parsed.payload?.type ? parsed.payload : parsed
                const props = payload.properties || {}
                const payloadSessionId = props?.sessionID || props?.part?.sessionID || props?.info?.sessionID

                if (payload.type === "server.connected" || payload.type === "server.heartbeat") continue

                if (payload.type === "permission.asked") {
                  if (props?.sessionID !== sessionId) continue
                  await context.sendPermissionRequestPrompt(chatId, props)
                  continue
                }

                if (payload.type === "question.asked") {
                  if (props?.sessionID !== sessionId) continue
                  await context.sendQuestionRequestPrompt(chatId, props)
                  continue
                }

                if (payload.type === "question.replied" || payload.type === "question.rejected") {
                  if (props?.sessionID !== sessionId) continue
                  const requestId = props?.requestID
                  if (!requestId) continue
                  clearQuestionState(chatId, requestId)
                  continue
                }

                if (payloadSessionId && payloadSessionId !== sessionId) continue

                const state = getChatState(chatId)

                if (payload.type === "session.error") {
                  const errorMessage = extractSessionErrorMessage(payload)
                  console.error(`[SESSION_ERROR] session=${sessionId} error: ${errorMessage || "unknown"}`)
                  pendingUserTexts.delete(sessionId)
                  stopTypingIndicator(chatId)
                  clearResponseTracking(chatId)
                  clearDrafts(chatId)
                  for (const bubble of state.bubbles.values()) bubble.done = true
                  await context.bot.sendMessage(chatId, buildSessionErrorNotice(errorMessage), {
                    parse_mode: "HTML",
                    link_preview_options: { is_disabled: true },
                  } as any).catch(() => { })
                  return
                }

                if (payload.type === "session.idle") {
                  pendingUserTexts.delete(sessionId)
                  stopTypingIndicator(chatId)
                  clearResponseTracking(chatId)
                  clearDrafts(chatId)
                  return
                }

                if (payload.type === "session.status") {
                  if (props?.status?.type === "idle") {
                    pendingUserTexts.delete(sessionId)
                    stopTypingIndicator(chatId)
                    clearResponseTracking(chatId)
                    clearDrafts(chatId)
                    return
                  }
                  continue
                }

                if (payload.type === "message.part.updated") {
                  const part = props.part
                  if (!part?.id || processedPartIds.has(part.id)) continue

                  if (part.type === "text" || part.type === "reasoning") {
                    const userText = pendingUserTexts.get(sessionId)
                    if (part.type === "text" && userText !== undefined && part.text === userText) continue

                    const content = (part.type === "reasoning" ? (part.reasoning || part.text) : part.text) || ""
                    const hasContent = typeof content === "string" && content.trim() !== ""
                    const buffered = deltaBuf.get(part.id) || ""
                    const finalContent = hasContent ? content : (buffered.trim() ? buffered : "")

                    if (finalContent) {
                      if (!state.bubbles.has(part.id)) {
                        const bubble = new Bubble(part.id, part.type)
                        bubble.text = hasContent ? content : buffered
                        state.bubbles.set(part.id, bubble)
                        state.bubbleOrder.push(part.id)
                        void triggerWorker(chatId)
                      }

                      const bubble = state.bubbles.get(part.id)!
                      bubble.partType = part.type
                      bubble.text = hasContent ? content : (bubble.text || buffered)
                      deltaBuf.delete(part.id)
                    }

                    if (part.time?.end) {
                      processedPartIds.add(part.id)
                      if (state.bubbles.has(part.id)) {
                        state.bubbles.get(part.id)!.done = true
                      }
                    }
                  }

                  if (part.type === "tool") {
                    const now = Date.now()
                    if (part.state?.status === "running" && now - lastToolDraftAt > 2000) {
                      lastToolDraftAt = now
                      void sendDraft(chatId, 9999, `⚙️ 正在执行: ${part.tool || "unknown"}…`)
                    }
                  }
                  continue
                }

                if (payload.type === "message.part.delta") {
                  if ((props.field === "text" || props.field === "reasoning") && props.partID) {
                    if (processedPartIds.has(props.partID)) continue

                    if (state.bubbles.has(props.partID)) {
                      state.bubbles.get(props.partID)!.text += props.delta
                    } else {
                      deltaBuf.set(props.partID, (deltaBuf.get(props.partID) || "") + props.delta)
                    }
                  }
                }
              } catch {
                continue
              }
            }
          }
        } catch (error) {
          if (controller.signal.aborted || !isTrackedResponseActive(chatId, sessionId, nonce)) {
            settleReady(resolveReady)
            return
          }

          if (!readySettled) {
            settleReady(() => rejectReady(error))
            throw error
          }

          console.error(`[SSE_SCOPED_ERROR] chat=${chatId} session=${sessionId}`, error)
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }

      settleReady(resolveReady)
    })()

    return { ready, task }
  }

  async function triggerWorker(chatId: number) {
    const state = getChatState(chatId)
    if (state.processing) return
    state.processing = true

    try {
      while (state.bubbleOrder.length > 0) {
        const bubbleId = state.bubbleOrder[0]
        const bubble = state.bubbles.get(bubbleId)!
        console.log(`[BUBBLE] 渲染气泡 id=${bubbleId} partType="${bubble.partType}" textLen=${bubble.text.length}`)
        let lastDraftTime = 0
        const startWait = Date.now()
        const maxWait = bubble.partType === "reasoning" ? 8000 : 30000

        while (!bubble.done) {
          const now = Date.now()
          if (now - startWait > maxWait && bubble.text.trim() === "") {
            break
          }
          if (now - startWait > maxWait) {
            bubble.done = true
            break
          }
          if (bubble.text.trim() && bubble.text !== bubble.lastDraftText && now - lastDraftTime > 250) {
            bubble.lastDraftText = bubble.text
            lastDraftTime = now
            const prefix = bubble.partType === "reasoning" ? "🤔 思考中...\n\n" : ""
            void sendDraft(chatId, bubble.draftId, prefix + bubble.text)
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }

        if (bubble.text !== bubble.lastDraftText && bubble.text.trim()) {
          const prefix = bubble.partType === "reasoning" ? "🤔 思考中...\n\n" : ""
          await sendDraft(chatId, bubble.draftId, prefix + bubble.text).catch(() => { })
        }

        const text = bubble.text.trim()
        if (text) {
          stopTypingIndicator(chatId)
          await sendRenderedAssistantPart(context.bot, chatId, bubble.partType, text)
          await sendDraft(chatId, bubble.draftId, "").catch(() => { })
        }

        state.bubbleOrder.shift()
        state.bubbles.delete(bubbleId)
      }
    } finally {
      state.processing = false
    }
  }

  async function dispatchPromptMessage(chatId: number, normalized: NormalizedInboundMessage) {
    const sessionId = await context.ensureSession(chatId)
    const backend = await context.resolveOpencodeBackend().catch(() => null)
    const worktree = await context.getActiveProjectWorktree(chatId)
    const shouldUseScopedEventStream =
      !!backend && backend.source !== "env" && !!worktree
    const shouldPollResponse = !!backend && backend.source !== "env" && !shouldUseScopedEventStream
    const knownAssistantMessageIds = shouldPollResponse
      ? await captureKnownAssistantMessageIds(chatId, sessionId)
      : new Set<string>()

    resetChatStreamState(chatId)
    const responseNonce = beginTrackedResponse(chatId, sessionId, shouldPollResponse ? "poll" : "sse")
    await startTypingIndicator(chatId)

    let attachments: ResolvedTelegramAttachment[] = []
    try {
      if (shouldUseScopedEventStream && worktree) {
        const stream = createScopedSessionResponseStream(chatId, sessionId, responseNonce, worktree)
        void stream.task.catch((error) => handleResponseError(chatId, sessionId, responseNonce, error))
        await stream.ready
      }

      attachments = await context.resolveInboundAttachments(normalized)
      const modelInfo = attachments.length > 0 ? await context.resolveEffectiveModelInfo(chatId) : undefined
      const parts = buildPromptParts({ bodyText: normalized.bodyText, attachments, model: modelInfo })
      const userEchoText = parts.find((part) => part.type === "text")?.text
      if (userEchoText) pendingUserTexts.set(sessionId, userEchoText)

      await sendSessionPromptAsync({
        sessionId,
        agent: context.resolveSelectedAgent(chatId),
        model: context.resolveSelectedModel(chatId),
        parts,
        headers: await context.buildProjectScopedHeaders({ chatId }),
      })

      if (shouldPollResponse) {
        void pollSessionResponse(chatId, sessionId, responseNonce, knownAssistantMessageIds).catch((error) =>
          handleResponseError(chatId, sessionId, responseNonce, error),
        )
      }

      context.scheduleAttachmentCleanup(attachments.map((item) => item.path))
    } catch (error) {
      context.scheduleAttachmentCleanup(attachments.map((item) => item.path), 1000)
      clearResponseTracking(chatId)
      throw error
    }
  }

  async function dispatchCustomCommand(
    chatId: number,
    normalized: NormalizedInboundMessage,
    command: string,
    args: string,
  ) {
    const sessionId = await context.ensureSession(chatId)
    const backend = await context.resolveOpencodeBackend().catch(() => null)
    const worktree = await context.getActiveProjectWorktree(chatId)
    const shouldUseScopedEventStream =
      !!backend && backend.source !== "env" && !!worktree
    const shouldPollResponse = !!backend && backend.source !== "env" && !shouldUseScopedEventStream
    const knownAssistantMessageIds = shouldPollResponse
      ? await captureKnownAssistantMessageIds(chatId, sessionId)
      : new Set<string>()

    resetChatStreamState(chatId)
    const responseNonce = beginTrackedResponse(chatId, sessionId, shouldPollResponse ? "poll" : "sse")
    await startTypingIndicator(chatId)

    let attachments: ResolvedTelegramAttachment[] = []
    try {
      if (shouldUseScopedEventStream && worktree) {
        const stream = createScopedSessionResponseStream(chatId, sessionId, responseNonce, worktree)
        void stream.task.catch((error) => handleResponseError(chatId, sessionId, responseNonce, error))
        await stream.ready
      }

      attachments = await context.resolveInboundAttachments(normalized)
      await sendSessionCommand({
        sessionId,
        agent: context.resolveSelectedAgent(chatId),
        model: context.resolveSelectedModel(chatId),
        command,
        arguments: args,
        parts: attachments.length ? buildCommandFileParts(attachments) : undefined,
        headers: await context.buildProjectScopedHeaders({ chatId }),
      })

      if (shouldPollResponse) {
        void pollSessionResponse(chatId, sessionId, responseNonce, knownAssistantMessageIds).catch((error) =>
          handleResponseError(chatId, sessionId, responseNonce, error),
        )
      }

      context.scheduleAttachmentCleanup(attachments.map((item) => item.path))
    } catch (error) {
      context.scheduleAttachmentCleanup(attachments.map((item) => item.path), 1000)
      clearResponseTracking(chatId)
      throw error
    }
  }

  async function listenEvents() {
    const processedPartIds = new Set<string>()
    const partSessionMap = new Map<string, string>()
    const lastToolDraftTime = new Map<number, number>()
    const deltaBuf = new Map<string, string>()

    while (true) {
      try {
        const res = await context.fetchWithOpencodeTimeout("/event", { headers: {} })
        if (!res.body) throw new Error("No response body in /event")
        console.log("🟢 SSE 流连接成功")

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const chunks = buffer.split("\n\n")
          buffer = chunks.pop() || ""

          for (const chunk of chunks) {
            if (!chunk.startsWith("data: ")) continue

            try {
              const parsed = JSON.parse(chunk.slice(6))
              if (!parsed) continue

              const payload = parsed.payload?.type ? parsed.payload : parsed
              if (
                payload.type &&
                ![
                  "message.part.updated",
                  "message.part.delta",
                  "server.connected",
                  "server.heartbeat",
                  "message.updated",
                  "session.status",
                  "question.asked",
                  "question.replied",
                  "question.rejected",
                  "file.watcher.updated",
                ].includes(payload.type)
              ) {
                console.log(`[SSE-EVENT] type="${payload.type}" keys=${JSON.stringify(Object.keys(payload.properties || {}))}`)
              }

              if (payload.type === "permission.asked") {
                const perm = payload.properties
                const permSessionId = perm?.sessionID
                if (!permSessionId) continue

                console.log(`[PERMISSION] 收到权限请求 id=${perm?.id} session=${permSessionId} permission=${perm?.permission}`)
                const permChatId = getChatIdForSession(permSessionId)
                if (!permChatId) continue
                await context.sendPermissionRequestPrompt(permChatId, perm)
                continue
              }

              if (payload.type === "question.asked") {
                const request = payload.properties
                const requestSessionId = request?.sessionID
                if (!requestSessionId) continue

                const questionChatId = getChatIdForSession(requestSessionId)
                if (!questionChatId) continue
                await context.sendQuestionRequestPrompt(questionChatId, request)
                continue
              }

              if (payload.type === "question.replied" || payload.type === "question.rejected") {
                const requestSessionId = payload.properties?.sessionID
                const requestId = payload.properties?.requestID
                if (!requestSessionId || !requestId) continue

                const questionChatId = getChatIdForSession(requestSessionId)
                if (!questionChatId) continue
                clearQuestionState(questionChatId, requestId)
                continue
              }

              let sessionID = payload.properties?.sessionID || payload.properties?.part?.sessionID || payload.properties?.info?.sessionID
              if (!sessionID && payload.type === "message.part.delta") {
                const partId = payload.properties?.partID
                if (partId) sessionID = partSessionMap.get(partId)
              }
              if (!sessionID) continue

              const targetChatId = getChatIdForSession(sessionID)
              if (!targetChatId) continue

              const state = getChatState(targetChatId)
              const pollManagedSession = state.responseMode === "poll" && state.responseSessionId === sessionID

              if (payload.type === "session.error") {
                const errorMessage = extractSessionErrorMessage(payload)
                console.error(`[SESSION_ERROR] session=${sessionID} error: ${errorMessage || "unknown"}`)
                pendingUserTexts.delete(sessionID)
                stopTypingIndicator(targetChatId)
                clearResponseTracking(targetChatId)
                clearDrafts(targetChatId)
                for (const bubble of state.bubbles.values()) bubble.done = true
                await context.bot.sendMessage(targetChatId, buildSessionErrorNotice(errorMessage), {
                  parse_mode: "HTML",
                  link_preview_options: { is_disabled: true },
                } as any).catch((error: any) => {
                  console.error("[SESSION_ERROR] sendMessage failed:", error.message)
                })
                continue
              }

              if (
                pollManagedSession &&
                (
                  payload.type === "session.idle" ||
                  payload.type === "session.status" ||
                  payload.type === "message.part.updated" ||
                  payload.type === "message.part.delta" ||
                  payload.type === "permission.asked"
                )
              ) {
                continue
              }

              if (payload.type === "session.idle") {
                pendingUserTexts.delete(sessionID)
                stopTypingIndicator(targetChatId)
                clearResponseTracking(targetChatId)
                clearDrafts(targetChatId)
                continue
              }

              if (payload.type === "session.status") {
                const statusSessionID = payload.properties?.sessionID
                const statusType = payload.properties?.status?.type
                if (statusSessionID !== sessionID) continue

                if (statusType === "idle") {
                  pendingUserTexts.delete(sessionID)
                  stopTypingIndicator(targetChatId)
                  clearResponseTracking(targetChatId)
                  clearDrafts(targetChatId)
                }
                continue
              }

              if (payload.type === "message.part.updated") {
                const part = payload.properties.part
                if (!part?.id) continue
                partSessionMap.set(part.id, sessionID)
                if (processedPartIds.has(part.id)) continue

                if (part.type === "text" || part.type === "reasoning") {
                  const userText = pendingUserTexts.get(sessionID)
                  if (part.type === "text" && userText !== undefined && part.text === userText) continue

                  const content = (part.type === "reasoning" ? (part.reasoning || part.text) : part.text) || ""
                  const hasContent = typeof content === "string" && content.trim() !== ""
                  const buffered = deltaBuf.get(part.id) || ""
                  const finalContent = hasContent ? content : (buffered.trim() ? buffered : "")

                  if (finalContent) {
                    if (!state.bubbles.has(part.id)) {
                      console.log(`[SSE-UPDATED] 创建气泡 key=${part.id} partType="${part.type}" len=${finalContent.length}`)
                      const bubble = new Bubble(part.id, part.type)
                      bubble.text = hasContent ? content : buffered
                      state.bubbles.set(part.id, bubble)
                      state.bubbleOrder.push(part.id)
                      void triggerWorker(targetChatId)
                    }

                    const bubble = state.bubbles.get(part.id)!
                    if (part.type === "reasoning" && bubble.partType !== "reasoning") {
                      bubble.partType = part.type
                    }
                    bubble.text = hasContent ? content : (bubble.text || buffered)
                    deltaBuf.delete(part.id)
                  }

                  if (part.time?.end) {
                    processedPartIds.add(part.id)
                    pendingUserTexts.delete(sessionID)
                    if (state.bubbles.has(part.id)) {
                      state.bubbles.get(part.id)!.done = true
                    }
                  }
                }

                if (part.type === "tool") {
                  const now = Date.now()
                  const lastTime = lastToolDraftTime.get(targetChatId) || 0
                  if (part.state?.status === "running" && now - lastTime > 2000) {
                    lastToolDraftTime.set(targetChatId, now)
                    void sendDraft(targetChatId, 9999, `⚙️ 正在执行: ${part.tool || "unknown"}…`)
                  }
                }
                continue
              }

              if (payload.type === "message.part.delta") {
                const props = payload.properties
                if ((props.field === "text" || props.field === "reasoning") && props.partID) {
                  pendingUserTexts.delete(sessionID)
                  if (processedPartIds.has(props.partID)) continue

                  if (state.bubbles.has(props.partID)) {
                    state.bubbles.get(props.partID)!.text += props.delta
                  } else {
                    deltaBuf.set(props.partID, (deltaBuf.get(props.partID) || "") + props.delta)
                  }
                }
              }
            } catch {
              continue
            }
          }
        }
      } catch (error) {
        console.error("SSE 异常，2秒后重连", error)
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }
  }

  return {
    clearDrafts,
    clearResponseTracking,
    dispatchCustomCommand,
    dispatchPromptMessage,
    disposeChatState,
    hasActiveResponse,
    listenEvents,
    startTypingIndicator,
    stopTypingIndicator,
  }
}
