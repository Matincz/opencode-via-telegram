import * as os from "os"
import { describe, expect, it } from "bun:test"
import { createProjectSessionManager, getProjectDisplayName } from "./project-session"
import { clearChatSession, setChatSession } from "../store/runtime-state"

describe("getProjectDisplayName", () => {
  it("keeps root readable", () => {
    expect(getProjectDisplayName("/")).toBe("/")
  })

  it("keeps single segment paths readable", () => {
    expect(getProjectDisplayName("/repo")).toBe("/repo")
  })

  it("compresses deep paths to the last two segments", () => {
    expect(getProjectDisplayName("/Users/demo/opencode-via-telegram")).toBe(".../demo/opencode-via-telegram")
  })
})

describe("createProjectSessionManager", () => {
  it("uses the current Desktop project worktree even when following the current project", async () => {
    const manager = createProjectSessionManager({
      listProjects: async () => [],
      resolveOpencodeBackend: async () => ({ source: "desktop-sidecar" }),
      opencodeGet: async (pathname: string) => {
        if (pathname === "/project/current") return { worktree: os.homedir() }
        return null
      },
      opencodePost: async () => null,
      disposeChatState: () => { },
    })

    await expect(manager.getActiveProjectWorktree(1)).resolves.toBe(os.homedir())
    await expect(manager.buildProjectScopedHeaders({ chatId: 1 })).resolves.toEqual({
      "x-opencode-directory": os.homedir(),
    })
  })

  it("reverts the latest user message via the documented revert endpoint", async () => {
    const calls: Array<{ pathname: string; body: any; chatId?: number; scoped?: boolean }> = []
    const manager = createProjectSessionManager({
      listProjects: async () => [],
      resolveOpencodeBackend: async () => ({ source: "desktop-sidecar" }),
      opencodeGet: async (pathname: string) => {
        if (pathname === "/session/ses_1/message") {
          return [
            { info: { role: "user", id: "msg_1" } },
            { info: { role: "assistant", id: "msg_2" } },
            { info: { role: "user", id: "msg_3" } },
          ]
        }
        return null
      },
      opencodePost: async (pathname: string, body: any, chatId?: number, scoped?: boolean) => {
        calls.push({ pathname, body, chatId, scoped })
        return { ok: true }
      },
      disposeChatState: () => { },
    })

    setChatSession(7, "ses_1")

    await manager.revertLastUserMessage(7)

    expect(calls).toEqual([{
      pathname: "/session/ses_1/revert",
      body: { messageID: "msg_3" },
      chatId: 7,
      scoped: true,
    }])

    clearChatSession(7)
  })

  it("calls the documented unrevert endpoint", async () => {
    const calls: Array<{ pathname: string; body: any; chatId?: number; scoped?: boolean }> = []
    const manager = createProjectSessionManager({
      listProjects: async () => [],
      resolveOpencodeBackend: async () => ({ source: "desktop-sidecar" }),
      opencodeGet: async () => null,
      opencodePost: async (pathname: string, body: any, chatId?: number, scoped?: boolean) => {
        calls.push({ pathname, body, chatId, scoped })
        return { ok: true }
      },
      disposeChatState: () => { },
    })

    setChatSession(8, "ses_2")

    await manager.unrevertSession(8)

    expect(calls).toEqual([{
      pathname: "/session/ses_2/unrevert",
      body: {},
      chatId: 8,
      scoped: true,
    }])

    clearChatSession(8)
  })
})
