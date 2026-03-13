import { afterEach, describe, expect, it } from "bun:test"
import { buildSessionErrorNotice, createDraftSender, escapeHtml, markdownToTelegramHtml } from "./rendering"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
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
})
