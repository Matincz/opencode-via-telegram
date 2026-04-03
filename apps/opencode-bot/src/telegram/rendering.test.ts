import { afterEach, describe, expect, it, mock } from "bun:test"
import { buildSessionErrorNotice, createDraftSender, escapeHtml, markdownToTelegramHtml, sendRenderedAssistantPart } from "./rendering"

const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.setTimeout = originalSetTimeout
  mock.restore()
})

describe("escapeHtml", () => {
  it("escapes reserved HTML characters", () => {
    expect(escapeHtml(`<tag attr="x">&value`)).toBe(`&lt;tag attr="x"&gt;&amp;value`)
  })
})

describe("markdownToTelegramHtml", () => {
  it("keeps inline code and emphasis compatible with Telegram HTML", () => {
    expect(markdownToTelegramHtml("Use `bun test` and **watch logs**")).toBe(
      "Use <code>bun test</code> and <b>watch logs</b>",
    )
  })
})

describe("buildSessionErrorNotice", () => {
  it("adds a /new hint for unsupported mixed media sessions", () => {
    const notice = buildSessionErrorNotice("AI_UnsupportedFunctionalityError: file part media type")
    expect(notice).toContain("发送 /new 新建会话后再试")
  })
})

describe("createDraftSender", () => {
  it("sends a zero-width space when clearing a draft", async () => {
    let payload: any = null
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body || "{}"))
      return new Response("ok")
    }) as typeof fetch

    const sendDraft = createDraftSender("https://example.test")
    await sendDraft(1, 2, "")

    expect(payload).toEqual({
      chat_id: 1,
      draft_id: 2,
      text: "\u200b",
    })
  })

  it("suppresses empty-draft cleanup errors from Telegram draft API", async () => {
    const consoleLog = mock(() => { })
    console.log = consoleLog as typeof console.log
    globalThis.fetch = (async () => new Response(
      JSON.stringify({
        ok: false,
        error_code: 400,
        description: "Bad Request: text must be non-empty",
      }),
      { status: 400 },
    )) as unknown as typeof fetch

    const sendDraft = createDraftSender("https://example.test")
    await expect(sendDraft(1, 2, "")).resolves.toBeUndefined()
    expect(consoleLog).not.toHaveBeenCalled()
  })
})

describe("sendRenderedAssistantPart", () => {
  it("retries transient Telegram send failures", async () => {
    globalThis.setTimeout = ((fn: (...args: any[]) => void) => {
      fn()
      return 0 as any
    }) as typeof setTimeout

    const sendMessage = mock()
    sendMessage
      .mockRejectedValueOnce(new Error("ETELEGRAM: 504 Gateway Timeout"))
      .mockResolvedValueOnce({ message_id: 99 })

    const deleteMessage = mock(async () => ({ ok: true }))

    await sendRenderedAssistantPart(
      {
        sendMessage,
        deleteMessage,
      } as any,
      1,
      "reasoning",
      "retry me",
    )

    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(deleteMessage).toHaveBeenCalledWith(1, 99)
  })

  it("keeps reasoning parts labeled as thought process", async () => {
    globalThis.setTimeout = ((fn: (...args: any[]) => void) => {
      fn()
      return 0 as any
    }) as typeof setTimeout

    let renderedMessage = ""
    const sendMessage = mock(async (_chatId: number, text: string) => {
      renderedMessage = text
      return { message_id: 12 }
    })
    const deleteMessage = mock(async () => ({ ok: true }))

    await sendRenderedAssistantPart(
      {
        sendMessage,
        deleteMessage,
      } as any,
      1,
      "reasoning",
      "think",
    )

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(renderedMessage).toContain("思考过程")
    expect(deleteMessage).toHaveBeenCalledWith(1, 12)
  })
})
