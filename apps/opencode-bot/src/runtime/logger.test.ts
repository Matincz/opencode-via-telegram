import { describe, expect, it } from "bun:test"
import { formatLogContext, parseStackFrameLine } from "./logger"

describe("parseStackFrameLine", () => {
  it("parses stack frames with function wrappers", () => {
    expect(parseStackFrameLine("    at write (/Users/test/project/src/file.ts:12:34)"))
      .toBe("/Users/test/project/src/file.ts:12:34")
  })

  it("parses stack frames without function wrappers", () => {
    expect(parseStackFrameLine("    at /Users/test/project/index.ts:56:7"))
      .toBe("/Users/test/project/index.ts:56:7")
  })

  it("ignores non-frame lines", () => {
    expect(parseStackFrameLine("Error: boom")).toBeUndefined()
  })
})

describe("formatLogContext", () => {
  it("formats simple key value pairs for log correlation", () => {
    expect(formatLogContext({
      chatId: 123,
      sessionId: "ses_1",
      worktree: "/Users/test/project",
    })).toBe('chatId=123 sessionId=ses_1 worktree=/Users/test/project')
  })

  it("quotes string values that contain spaces", () => {
    expect(formatLogContext({
      worktree: "/Users/test/My Project",
    })).toBe('worktree="/Users/test/My Project"')
  })
})
