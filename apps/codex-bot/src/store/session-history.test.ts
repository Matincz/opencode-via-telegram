import { beforeEach, describe, expect, it } from "bun:test"
import { getLatestSessionForWorkspace, listChatSessions, rememberSession, sessionHistoryMap } from "./session-history"

describe("session history workspace binding", () => {
  beforeEach(() => {
    sessionHistoryMap.clear()
  })

  it("filters sessions by workspace", () => {
    rememberSession(1, "session-a", {
      label: "A",
      workspace: "/tmp/work-a",
      usedAt: "2026-03-24T00:00:00.000Z",
    })
    rememberSession(1, "session-b", {
      label: "B",
      workspace: "/tmp/work-b",
      usedAt: "2026-03-24T01:00:00.000Z",
    })

    expect(listChatSessions(1, { workspace: "/tmp/work-a" }).map((record) => record.id)).toEqual(["session-a"])
    expect(listChatSessions(1, { workspace: "/tmp/work-b" }).map((record) => record.id)).toEqual(["session-b"])
  })

  it("returns the latest session for a workspace", () => {
    rememberSession(1, "session-old", {
      workspace: "/tmp/work-a",
      usedAt: "2026-03-24T00:00:00.000Z",
    })
    rememberSession(1, "session-new", {
      workspace: "/tmp/work-a",
      usedAt: "2026-03-24T01:00:00.000Z",
    })

    expect(getLatestSessionForWorkspace(1, "/tmp/work-a")?.id).toBe("session-new")
  })
})
