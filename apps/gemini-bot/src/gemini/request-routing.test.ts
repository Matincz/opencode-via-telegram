import { describe, expect, it } from "bun:test"
import { classifyGeminiRequest } from "./request-routing"

describe("request-routing", () => {
  it("routes weather queries through the direct path", () => {
    const route = classifyGeminiRequest("明天临安天气怎么样", [])
    expect(route.mode).toBe("direct")
  })

  it("routes chat style prompts through the direct path", () => {
    const route = classifyGeminiRequest("说中文", [])
    expect(route.mode).toBe("direct")
  })

  it("routes filesystem path requests through the agent path", () => {
    const route = classifyGeminiRequest("查看文件 @/desktop", [])
    expect(route.mode).toBe("agent")
  })

  it("routes code modification requests through the agent path", () => {
    const route = classifyGeminiRequest("帮我修改这个项目里的 bug", [])
    expect(route.mode).toBe("agent")
  })

  it("keeps attachment-only analysis on the direct path", () => {
    const route = classifyGeminiRequest("", [
      {
        kind: "document",
        telegramFileId: "1",
        messageId: 1,
        filename: "a.txt",
        mime: "text/plain",
        sizeBytes: 1,
        path: "/tmp/a.txt",
      },
    ])
    expect(route.mode).toBe("direct")
  })
})
