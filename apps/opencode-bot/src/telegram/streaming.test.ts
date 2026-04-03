import { afterEach, describe, expect, it, mock } from "bun:test"
import { createTelegramStreaming } from "./streaming"
import type { NormalizedInboundMessage } from "./types"

const originalFetch = globalThis.fetch
const originalSetInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval
const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout

function createStreamingContext(overrides: Partial<Parameters<typeof createTelegramStreaming>[0]> = {}) {
  return {
    bot: {
      sendChatAction: mock(async () => ({ ok: true })),
      sendMessage: mock(async () => ({ ok: true })),
    } as any,
    tgApiBase: "https://api.telegram.org/bot-test-token",
    opencodeRequestTimeoutMs: 1000,
    opencodeResponsePollIntervalMs: 100,
    opencodeResponsePollTimeoutMs: 1000,
    opencodeResponsePollMessageLimit: 20,
    resolveOpencodeBackend: async () => ({ baseUrl: "https://backend.test", headers: {}, source: "remote" }),
    fetchWithOpencodeTimeout: async () => {
      throw new Error("unexpected fetch")
    },
    opencodeGet: async () => [],
    ensureSession: async () => "session-1",
    getActiveProjectWorktree: async () => undefined,
    buildProjectScopedHeaders: async () => ({}),
    isOverlyBroadProjectWorktree: () => false,
    resolveInboundAttachments: async () => [],
    scheduleAttachmentCleanup: () => { },
    resolveSelectedAgent: () => undefined,
    resolveSelectedModel: () => undefined,
    resolveEffectiveModelInfo: async () => undefined,
    sendPermissionRequestPrompt: async () => { },
    sendQuestionRequestPrompt: async () => { },
    ...overrides,
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.setInterval = originalSetInterval
  globalThis.clearInterval = originalClearInterval
  globalThis.setTimeout = originalSetTimeout
  globalThis.clearTimeout = originalClearTimeout
  mock.restore()
})

describe("createTelegramStreaming", () => {
  it("stops the typing indicator when prompt dispatch fails before sending", async () => {
    const intervalToken = { id: "typing-interval" } as unknown as ReturnType<typeof setInterval>
    const setIntervalMock = mock(() => intervalToken)
    const clearIntervalMock = mock(() => { })

    globalThis.setInterval = setIntervalMock as unknown as typeof setInterval
    globalThis.clearInterval = clearIntervalMock as unknown as typeof clearInterval

    const sendChatAction = mock(async () => ({ ok: true }))
    const streaming = createTelegramStreaming(createStreamingContext({
      bot: {
        sendChatAction,
        sendMessage: mock(async () => ({ ok: true })),
      } as any,
      resolveOpencodeBackend: async () => {
        throw new Error("backend unavailable")
      },
      resolveInboundAttachments: async () => {
        throw new Error("attachment resolution failed")
      },
    }))

    const normalized: NormalizedInboundMessage = {
      chatId: 123,
      messageId: 1,
      messageIds: [1],
      bodyText: "hello",
      bodySource: "text",
      attachments: [],
    }

    await expect(streaming.dispatchPromptMessage(123, normalized)).rejects.toThrow("attachment resolution failed")
    expect(sendChatAction).toHaveBeenCalledTimes(1)
    expect(setIntervalMock).toHaveBeenCalledTimes(1)
    expect(clearIntervalMock).toHaveBeenCalledTimes(1)
    expect(clearIntervalMock).toHaveBeenCalledWith(intervalToken)
  })

  it("times out scoped SSE responses and clears tracked state", async () => {
    const intervalToken = { id: "typing-interval" } as unknown as ReturnType<typeof setInterval>
    const setIntervalMock = mock(() => intervalToken)
    const clearIntervalMock = mock(() => { })
    const timeoutEntries: Array<{
      callback: () => void | Promise<void>
      ms: number
      token: ReturnType<typeof setTimeout>
    }> = []
    const setTimeoutMock = mock((fn: () => void | Promise<void>, ms?: number) => {
      const token = { id: `timeout-${timeoutEntries.length + 1}` } as unknown as ReturnType<typeof setTimeout>
      timeoutEntries.push({ callback: fn, ms: Number(ms || 0), token })
      return token
    })
    const clearTimeoutMock = mock(() => { })

    globalThis.setInterval = setIntervalMock as unknown as typeof setInterval
    globalThis.clearInterval = clearIntervalMock as unknown as typeof clearInterval
    globalThis.setTimeout = setTimeoutMock as unknown as typeof setTimeout
    globalThis.clearTimeout = clearTimeoutMock as unknown as typeof clearTimeout
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.close(), { once: true })
        },
      })
      return new Response(stream, { status: 200 })
    }) as typeof fetch

    const sendMessage = mock(async () => ({ ok: true }))
    const streaming = createTelegramStreaming(createStreamingContext({
      bot: {
        sendChatAction: mock(async () => ({ ok: true })),
        sendMessage,
      } as any,
      getActiveProjectWorktree: async () => "/tmp/project",
    }))

    const normalized: NormalizedInboundMessage = {
      chatId: 123,
      messageId: 1,
      messageIds: [1],
      bodyText: "hello",
      bodySource: "text",
      attachments: [],
    }

    await streaming.dispatchPromptMessage(123, normalized)
    expect(streaming.hasActiveTrackedResponse(123, "session-1")).toBe(true)
    expect(timeoutCallbacks.length).toBeGreaterThan(0)

    await timeoutCallbacks.at(-1)!()

    expect(streaming.hasActiveTrackedResponse(123, "session-1")).toBe(false)
    expect(clearIntervalMock).toHaveBeenCalledWith(intervalToken)
    expect(sendMessage).toHaveBeenCalledWith(123, "⚠️ 当前响应等待超时，请稍后重试，或发送 /stop 后重新开始。")
    expect(clearTimeoutMock).toHaveBeenCalledWith(timeoutToken)
  })

  it("keeps tracked response guard session-aware", () => {
    const streaming = createTelegramStreaming(createStreamingContext())

    expect(streaming.hasActiveTrackedResponse(123, "session-1")).toBe(false)
  })
})
