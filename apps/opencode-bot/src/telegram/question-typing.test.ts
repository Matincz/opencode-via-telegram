import { describe, expect, it, mock } from "bun:test"
import { createTelegramMessageProcessor } from "./message-processor"
import { handleTelegramCallbackQuery } from "./callback-query"
import { chatAwaitingQuestionInput, pendingQuestionRequests } from "../store/runtime-state"

describe("question typing guards", () => {
  it("restarts typing after text answer only for active tracked response", async () => {
    chatAwaitingQuestionInput.set(123, { requestId: "req-1", sessionId: "session-1" })

    const startTypingIndicator = mock(async () => { })
    const processor = createTelegramMessageProcessor({
      bot: { sendMessage: mock(async () => ({ ok: true })) } as any,
      streaming: {
        clearDrafts: () => { },
        clearResponseTracking: () => { },
        dispatchCustomCommand: async () => { },
        dispatchPromptMessage: async () => { },
        disposeChatState: () => { },
        hasActiveResponse: () => false,
        hasActiveTrackedResponse: (_chatId: number, sessionId: string) => sessionId === "session-1",
        startTypingIndicator,
        stopTypingIndicator: () => { },
      },
      sessionManager: {
        buildProjectScopedHeaders: async () => ({}),
        getProjectDisplayName: () => "",
        revertLastUserMessage: async () => undefined,
        unrevertSession: async () => undefined,
      },
      listProjects: async () => [],
      resolveOpencodeBackend: async () => ({ source: "remote", baseUrl: "https://backend.test" }),
      opencodeGet: async () => [],
      opencodePost: async () => undefined,
      opencodeDelete: async () => undefined,
      opencodePatch: async () => undefined,
      fetchWithOpencodeTimeout: async () => new Response(null, { status: 204 }),
      createCallbackToken: () => "token",
      getModelMenuContext: async () => ({ providers: [], currentModel: "" }),
      getProviderDisplayName: () => "",
      replyToQuestion: async () => undefined,
      finalizeQuestionPrompt: async () => undefined,
      escapeHtml: (value: string) => value,
      formatUserFacingError: (error: unknown) => String(error),
    })

    await processor([{ chat: { id: 123 }, message_id: 1, text: "answer" } as any])
    expect(startTypingIndicator).toHaveBeenCalledTimes(1)

    chatAwaitingQuestionInput.set(123, { requestId: "req-2", sessionId: "stale-session" })
    await processor([{ chat: { id: 123 }, message_id: 2, text: "stale" } as any])
    expect(startTypingIndicator).toHaveBeenCalledTimes(1)
    chatAwaitingQuestionInput.clear()
  })

  it("restarts typing from callback replies only for active tracked response", async () => {
    pendingQuestionRequests.set("req-1", {
      chatId: 123,
      sessionId: "session-1",
      text: "question",
      messageId: 10,
    })

    const startTypingIndicator = mock(async () => { })
    const query = {
      id: "cb-1",
      data: "q:token-1",
      message: { chat: { id: 123 }, message_id: 10, text: "question" },
    }

    await handleTelegramCallbackQuery(query, {
      bot: {
        answerCallbackQuery: mock(async () => ({ ok: true })),
      } as any,
      callbackPayloadMap: new Map(),
      permRequestMap: new Map(),
      questionActionMap: new Map([["token-1", { type: "reply", requestId: "req-1", answers: [["yes"]] }]]),
      listProjects: async () => [],
      buildProjectScopedHeaders: async () => ({}),
      fetchWithOpencodeTimeout: async () => new Response(null, { status: 204 }),
      replyToQuestion: async () => undefined,
      finalizeQuestionPrompt: async () => undefined,
      startTypingIndicator,
      hasActiveTrackedResponse: (_chatId: number, sessionId: string) => sessionId === "session-1",
      rejectQuestion: async () => undefined,
      disposeChatState: () => { },
      opencodeGet: async () => undefined,
      opencodePost: async () => undefined,
      getProjectDisplayName: () => "",
      isOverlyBroadProjectWorktree: () => false,
      escapeHtml: (value: string) => value,
      getModelMenuContext: async () => ({ providers: [], currentModel: "" }),
      getProviderDisplayName: () => "",
      createCallbackToken: () => "token",
    })

    expect(startTypingIndicator).toHaveBeenCalledTimes(1)

    pendingQuestionRequests.set("req-2", {
      chatId: 123,
      sessionId: "stale-session",
      text: "question",
      messageId: 11,
    })
    await handleTelegramCallbackQuery({ ...query, id: "cb-2", data: "q:token-2", message: { chat: { id: 123 }, message_id: 11, text: "question" } }, {
      bot: {
        answerCallbackQuery: mock(async () => ({ ok: true })),
      } as any,
      callbackPayloadMap: new Map(),
      permRequestMap: new Map(),
      questionActionMap: new Map([["token-2", { type: "reply", requestId: "req-2", answers: [["no"]] }]]),
      listProjects: async () => [],
      buildProjectScopedHeaders: async () => ({}),
      fetchWithOpencodeTimeout: async () => new Response(null, { status: 204 }),
      replyToQuestion: async () => undefined,
      finalizeQuestionPrompt: async () => undefined,
      startTypingIndicator,
      hasActiveTrackedResponse: (_chatId: number, sessionId: string) => sessionId === "session-1",
      rejectQuestion: async () => undefined,
      disposeChatState: () => { },
      opencodeGet: async () => undefined,
      opencodePost: async () => undefined,
      getProjectDisplayName: () => "",
      isOverlyBroadProjectWorktree: () => false,
      escapeHtml: (value: string) => value,
      getModelMenuContext: async () => ({ providers: [], currentModel: "" }),
      getProviderDisplayName: () => "",
      createCallbackToken: () => "token",
    })

    expect(startTypingIndicator).toHaveBeenCalledTimes(1)
    pendingQuestionRequests.clear()
  })
})
