import { describe, expect, it } from "bun:test"
import { buildSessionErrorNotice, escapeHtml, markdownToTelegramHtml } from "./rendering"

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
