import { afterEach, describe, expect, it, mock } from "bun:test"
import { sendSessionCommand, sendSessionPromptAsync } from "./client"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})

describe("sendSessionPromptAsync", () => {
  it("posts prompt_async with model and parts", async () => {
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:4096/session/ses_1/prompt_async")
      expect(init?.method).toBe("POST")
      expect(init?.headers).toEqual({ "Content-Type": "application/json" })

      const body = JSON.parse(String(init?.body))
      expect(body).toEqual({
        model: { providerID: "openai", modelID: "gpt-5.4" },
        parts: [{ type: "text", text: "hello" }],
      })

      return new Response(null, { status: 204 })
    })

    globalThis.fetch = fetchMock as unknown as typeof fetch

    await sendSessionPromptAsync({
      baseUrl: "http://127.0.0.1:4096",
      sessionId: "ses_1",
      model: { providerID: "openai", modelID: "gpt-5.4" },
      parts: [{ type: "text", text: "hello" }],
    })
  })
})

describe("sendSessionCommand", () => {
  it("posts command body with file parts", async () => {
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(body).toEqual({
        model: "openai/gpt-5.4",
        command: "/image",
        arguments: "describe",
        parts: [
          {
            type: "file",
            mime: "image/png",
            filename: "x.png",
            url: "file:///tmp/x.png",
          },
        ],
      })

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })

    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await sendSessionCommand({
      baseUrl: "http://127.0.0.1:4096",
      sessionId: "ses_1",
      model: { providerID: "openai", modelID: "gpt-5.4" },
      command: "/image",
      arguments: "describe",
      parts: [
        {
          type: "file",
          mime: "image/png",
          filename: "x.png",
          url: "file:///tmp/x.png",
        },
      ],
    })

    expect(result).toEqual({ ok: true })
  })
})
