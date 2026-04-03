import { describe, expect, test } from "bun:test"
import {
  createApprovalToken,
  setPendingApproval,
  getPendingApproval,
  getPendingApprovalForChat,
  clearPendingApproval,
  hasPendingApproval,
  buildPlanPrompt,
  buildExecutionPrompt,
  type PendingPlanApproval,
} from "./approval"
import { formatGeminiAttachmentReference } from "./attachment-paths"

function makeDummyApproval(overrides: Partial<PendingPlanApproval> = {}): PendingPlanApproval {
  return {
    token: overrides.token ?? createApprovalToken(),
    chatId: overrides.chatId ?? 100,
    artifactId: overrides.artifactId ?? "plan_test",
    userText: "fix the bug",
    planText: "1. Read file\n2. Fix bug",
    toolSummary: [],
    includeDirectories: [],
    attachments: [],
    createdAt: Date.now(),
    ...overrides,
  }
}

describe("approval state management", () => {
  test("setPendingApproval stores and retrieves by token", () => {
    const approval = makeDummyApproval({ chatId: 200 })
    setPendingApproval(approval)
    expect(getPendingApproval(approval.token)).toBeTruthy()
    expect(getPendingApproval(approval.token)!.chatId).toBe(200)
    clearPendingApproval(200)
  })

  test("hasPendingApproval reflects current state", () => {
    const chatId = 301
    expect(hasPendingApproval(chatId)).toBe(false)
    const approval = makeDummyApproval({ chatId })
    setPendingApproval(approval)
    expect(hasPendingApproval(chatId)).toBe(true)
    clearPendingApproval(chatId)
    expect(hasPendingApproval(chatId)).toBe(false)
  })

  test("getPendingApprovalForChat returns the active approval", () => {
    const chatId = 401
    const approval = makeDummyApproval({ chatId })
    setPendingApproval(approval)
    expect(getPendingApprovalForChat(chatId)?.token).toBe(approval.token)
    clearPendingApproval(chatId)
  })

  test("setPendingApproval replaces previous approval for same chat", () => {
    const chatId = 501
    const first = makeDummyApproval({ chatId, userText: "first" })
    const second = makeDummyApproval({ chatId, userText: "second" })
    setPendingApproval(first)
    setPendingApproval(second)
    expect(getPendingApproval(first.token)).toBeNull()
    expect(getPendingApproval(second.token)?.userText).toBe("second")
    clearPendingApproval(chatId)
  })
})

describe("buildPlanPrompt", () => {
  test("includes planning-only instructions and user text", () => {
    const result = buildPlanPrompt({
      history: [],
      userText: "refactor auth",
      attachments: [],
    })
    expect(result).toContain("PLANNING-ONLY")
    expect(result).toContain("refactor auth")
    expect(result).not.toContain("<conversation_history>")
  })

  test("includes history entries when provided", () => {
    const result = buildPlanPrompt({
      history: [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }],
      userText: "next question",
      attachments: [],
    })
    expect(result).toContain("User: hello")
    expect(result).toContain("Assistant: hi")
  })

  test("escapes attachment paths with spaces", () => {
    const result = buildPlanPrompt({
      history: [],
      userText: "analyze image",
      attachments: [
        {
          kind: "photo",
          path: "/Users/matincz/agents via telegram/telegram files/photo 1.webp",
          mime: "image/webp",
          filename: "photo 1.webp",
          telegramFileId: "file-1",
          messageId: 1,
          sizeBytes: 10,
        },
      ],
    })

    expect(result).toContain(formatGeminiAttachmentReference("/Users/matincz/agents via telegram/telegram files/photo 1.webp"))
  })
})

describe("buildExecutionPrompt", () => {
  test("includes plan text and user request", () => {
    const result = buildExecutionPrompt({
      userText: "fix bug",
      planText: "Step 1: read file",
      attachments: [],
    })
    expect(result).toContain("APPROVED")
    expect(result).toContain("Step 1: read file")
    expect(result).toContain("fix bug")
  })

  test("escapes attachment paths with spaces", () => {
    const result = buildExecutionPrompt({
      userText: "analyze image",
      planText: "Step 1: inspect attachment",
      attachments: [
        {
          kind: "photo",
          path: "/Users/matincz/agents via telegram/telegram files/photo 1.webp",
          mime: "image/webp",
          filename: "photo 1.webp",
          telegramFileId: "file-1",
          messageId: 1,
          sizeBytes: 10,
        },
      ],
    })

    expect(result).toContain(formatGeminiAttachmentReference("/Users/matincz/agents via telegram/telegram files/photo 1.webp"))
  })
})
