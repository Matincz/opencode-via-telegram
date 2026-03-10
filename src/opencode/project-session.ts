import * as path from "path"
import {
  activeProjectMap,
  cacheActiveProjectWorktree,
  clearChatSession,
  getCachedActiveProjectWorktree,
  isOverlyBroadProjectWorktree,
  saveSessions,
  selectedModelMap,
  sessionMap,
  setChatSession,
} from "../store/runtime-state"

export interface ProjectSessionManagerContext {
  resolveOpencodeBackend: (input?: { forceRefresh?: boolean }) => Promise<{ source: string }>
  opencodeGet: (path: string, chatId?: number, scoped?: boolean) => Promise<any>
  opencodePost: (path: string, body?: any, chatId?: number, scoped?: boolean) => Promise<any>
  parseModelRef: (model: string) => { providerID: string; modelID: string } | undefined
  disposeChatState: (chatId: number) => void
}

export function getProjectDisplayName(worktree: string): string {
  const parts = worktree.replace(/\/$/, "").split("/").filter(Boolean)
  if (parts.length === 0) return "/"
  if (parts.length === 1) return `/${parts[0]}`
  return `.../${parts[parts.length - 2]}/${parts[parts.length - 1]}`
}

export function createProjectSessionManager(context: ProjectSessionManagerContext) {
  const sessionEnsureLocks = new Map<number, Promise<string>>()

  async function getActiveProjectWorktree(chatId: number): Promise<string | undefined> {
    const explicit = activeProjectMap.get(chatId)
    if (explicit && explicit !== "__current__") {
      const cachedWorktree = getCachedActiveProjectWorktree(chatId)
      if (cachedWorktree) return cachedWorktree

      const projects: any[] = await context.opencodeGet("/project").catch(() => [])
      const project = projects.find((item: any) => item.id === explicit)
      if (project?.worktree) {
        const worktree = path.resolve(project.worktree)
        cacheActiveProjectWorktree(chatId, worktree)
        return worktree
      }
    }

    const current = await context.opencodeGet("/project/current").catch(() => null)
    if (typeof current?.worktree === "string" && !isOverlyBroadProjectWorktree(current.worktree)) {
      return current.worktree
    }

    return undefined
  }

  async function buildProjectScopedHeaders(input?: { chatId?: number; worktree?: string }) {
    const worktree = input?.worktree || (input?.chatId ? await getActiveProjectWorktree(input.chatId) : undefined)
    if (!worktree || isOverlyBroadProjectWorktree(worktree)) return {}

    const backend = await context.resolveOpencodeBackend().catch(() => null)
    if (!backend) return {}

    return { "x-opencode-directory": worktree }
  }

  async function ensureSession(chatId: number): Promise<string> {
    const existingLock = sessionEnsureLocks.get(chatId)
    if (existingLock) return existingLock

    const task = (async () => {
      let sessionId = sessionMap.get(chatId)
      const worktree = await getActiveProjectWorktree(chatId)
      const backend = await context.resolveOpencodeBackend().catch(() => null)

      if (!worktree && backend && backend.source !== "env") {
        throw new Error("当前未选择项目。请先发送 /projects 选择一个具体项目后再开始会话。")
      }

      if (sessionId) {
        const sessionInfo = await context.opencodeGet(`/session/${sessionId}`, chatId, true).catch(() => null)
        const sessionDirectory = typeof sessionInfo?.directory === "string" ? sessionInfo.directory : undefined
        const mismatchedDirectory =
          !!worktree && !!sessionDirectory && path.resolve(sessionDirectory) !== path.resolve(worktree)

        if (!sessionInfo || mismatchedDirectory) {
          clearChatSession(chatId)
          saveSessions()
          sessionId = undefined
          context.disposeChatState(chatId)
        }
      }

      if (!sessionId) {
        const data = await context.opencodePost("/session", { title: `Telegram Chat ${chatId}` }, chatId, true)
        if (!data?.id) {
          console.error(`❌ 为聊天 ${chatId} 创建会话失败:`, data)
          throw new Error("Cannot create session")
        }

        sessionId = data.id
        setChatSession(chatId, sessionId)
        saveSessions()
        console.log(`✅ 为聊天 ${chatId} 创建并持久化了新会话：${sessionId}（项目: ${worktree || "默认"}）`)
      }

      return sessionId
    })()

    sessionEnsureLocks.set(chatId, task)
    try {
      return await task
    } finally {
      if (sessionEnsureLocks.get(chatId) === task) {
        sessionEnsureLocks.delete(chatId)
      }
    }
  }

  async function runBuiltinCommand(chatId: number, command: string, args?: string) {
    const sessionId = await ensureSession(chatId)
    const selectedModel = selectedModelMap.get(chatId)
    return context.opencodePost(
      `/session/${sessionId}/command`,
      {
        model: selectedModel ? context.parseModelRef(selectedModel) : undefined,
        command,
        arguments: args || "",
      },
      chatId,
      true,
    )
  }

  return {
    buildProjectScopedHeaders,
    getActiveProjectWorktree,
    ensureSession,
    runBuiltinCommand,
  }
}
