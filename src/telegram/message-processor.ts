import * as path from "path"
import TelegramBot from "node-telegram-bot-api"
import {
  activeProjectMap,
  chatAwaitingQuestionInput,
  clearChatSession,
  clearQuestionState,
  isOverlyBroadProjectWorktree,
  saveSelectedAgents,
  saveSessions,
  selectedAgentMap,
  selectedModelMap,
  sessionMap,
} from "../store/runtime-state"
import { normalizeTelegramMessages, parseCommandText } from "./inbound"
import type { TelegramMessageLike } from "./types"

interface StreamingController {
  clearDrafts: (chatId: number) => void
  clearResponseTracking: (chatId: number) => void
  dispatchCustomCommand: (chatId: number, normalized: any, command: string, args: string) => Promise<void>
  dispatchPromptMessage: (chatId: number, normalized: any) => Promise<void>
  disposeChatState: (chatId: number) => void
  hasActiveResponse: (chatId: number) => boolean
  startTypingIndicator: (chatId: number) => Promise<void>
  stopTypingIndicator: (chatId: number) => void
}

interface SessionManager {
  buildProjectScopedHeaders: (input?: { chatId?: number; worktree?: string }) => Promise<HeadersInit>
  getProjectDisplayName: (worktree: string) => string
  revertLastUserMessage: (chatId: number) => Promise<any>
  unrevertSession: (chatId: number) => Promise<any>
}

export interface TelegramMessageProcessorContext {
  bot: TelegramBot
  streaming: StreamingController
  sessionManager: SessionManager
  listProjects: () => Promise<any[]>
  resolveOpencodeBackend: (input?: { forceRefresh?: boolean }) => Promise<{ source: string; baseUrl: string }>
  opencodeGet: (path: string, chatId?: number, scoped?: boolean) => Promise<any>
  opencodePost: (path: string, body?: any, chatId?: number, scoped?: boolean) => Promise<any>
  opencodeDelete: (path: string, chatId?: number, scoped?: boolean) => Promise<any>
  opencodePatch: (path: string, body: any, chatId?: number, scoped?: boolean) => Promise<any>
  fetchWithOpencodeTimeout: (path: string, init: RequestInit) => Promise<Response>
  createCallbackToken: (type: string, value: string) => string
  getModelMenuContext: (chatId: number) => Promise<{ providers: any[]; currentModel: string }>
  getProviderDisplayName: (provider: any) => string
  replyToQuestion: (chatId: number, requestId: string, answers: string[][]) => Promise<void>
  finalizeQuestionPrompt: (chatId: number, requestId: string, footer: string) => Promise<void>
  escapeHtml: (value: string) => string
  formatUserFacingError: (error: unknown) => string
}

export function createTelegramMessageProcessor(context: TelegramMessageProcessorContext) {
  return async function processTelegramMessages(messages: TelegramMessageLike[]) {
    const normalized = normalizeTelegramMessages(messages)
    if (!normalized) return

    const chatId = normalized.chatId
    const commandInput = parseCommandText(normalized.bodyText)
    const cmd = commandInput?.cmd ?? ""
    const args = commandInput?.args ?? ""
    console.log(`[TG_PROC] chat=${chatId} cmd=${cmd || "<prompt>"} body=${JSON.stringify(normalized.bodyText)}`)

    const awaitingQuestion = chatAwaitingQuestionInput.get(chatId)
    if (awaitingQuestion && !cmd) {
      const answer = normalized.bodyText.trim()
      if (!answer) {
        await context.bot.sendMessage(chatId, "✍️ 请发送一条文字消息作为问题回答。").catch(() => { })
        return
      }

      try {
        await context.replyToQuestion(chatId, awaitingQuestion.requestId, [[answer]])
        await context.finalizeQuestionPrompt(
          chatId,
          awaitingQuestion.requestId,
          `✅ 已回答：<code>${context.escapeHtml(answer).slice(0, 3000)}</code>`,
        )
        await context.bot.sendMessage(chatId, "✅ 已提交回答，OpenCode 继续处理中。").catch(() => { })
        await context.streaming.startTypingIndicator(chatId)
      } catch (error) {
        await context.bot.sendMessage(chatId, `⚠️ 提交问题回答失败: ${context.formatUserFacingError(error)}`).catch(() => { })
      }
      return
    }

    if (cmd === "/new") {
      if (sessionMap.has(chatId)) {
        console.log(`[TG_PROC] /new reset existing session chat=${chatId}`)
        context.streaming.clearDrafts(chatId)
        context.streaming.disposeChatState(chatId)
        clearChatSession(chatId)
        saveSessions()
        console.log(`[TG_SEND] /new reset reply chat=${chatId}`)
        await context.bot.sendMessage(chatId, "♻️ 对话上下文已重置。\n下次发消息将自动建立新会话。", {
          parse_mode: "HTML",
        })
        console.log(`[TG_SEND_OK] /new reset reply chat=${chatId}`)
      } else {
        console.log(`[TG_SEND] /new empty reply chat=${chatId}`)
        await context.bot.sendMessage(chatId, "📝 当前没有进行中的会话。")
        console.log(`[TG_SEND_OK] /new empty reply chat=${chatId}`)
      }
      return
    }

    if (cmd === "/stop") {
      const sessionId = sessionMap.get(chatId)
      if (!sessionId) {
        await context.bot.sendMessage(chatId, "📭 没有进行中的会话。")
        return
      }

      clearQuestionState(chatId)
      context.streaming.clearDrafts(chatId)
      context.streaming.disposeChatState(chatId)
      try {
        await context.fetchWithOpencodeTimeout(`/session/${sessionId}/abort`, {
          method: "POST",
          headers: await context.sessionManager.buildProjectScopedHeaders({ chatId }),
        })
        await context.bot.sendMessage(chatId, "⛔ 已中止当前响应。")
      } catch {
        await context.bot.sendMessage(chatId, "⚠️ 中止请求发送失败。")
      }
      return
    }

    if (cmd === "/plan") {
      selectedAgentMap.set(chatId, "plan")
      saveSelectedAgents()
      await context.bot.sendMessage(
        chatId,
        "🗺️ 已切换到 <b>Plan</b> 模式。\n下一条消息起只分析代码，不修改文件。\n使用 /build 切回默认模式。",
        { parse_mode: "HTML" },
      )
      return
    }

    if (cmd === "/build") {
      selectedAgentMap.set(chatId, "build")
      saveSelectedAgents()
      await context.bot.sendMessage(chatId, "🔨 已切换到 <b>Build</b> 模式。\n下一条消息起恢复默认开发模式。", {
        parse_mode: "HTML",
      })
      return
    }

    if (cmd === "/undo") {
      if (!sessionMap.get(chatId)) {
        await context.bot.sendMessage(chatId, "📭 没有进行中的会话。")
        return
      }
      try {
        await context.sessionManager.revertLastUserMessage(chatId)
        await context.bot.sendMessage(chatId, "↩️ 已撤销上一次操作。")
      } catch {
        await context.bot.sendMessage(chatId, "⚠️ 撤销失败。")
      }
      return
    }

    if (cmd === "/redo") {
      if (!sessionMap.get(chatId)) {
        await context.bot.sendMessage(chatId, "📭 没有进行中的会话。")
        return
      }
      try {
        await context.sessionManager.unrevertSession(chatId)
        await context.bot.sendMessage(chatId, "↪️ 已重做操作。")
      } catch {
        await context.bot.sendMessage(chatId, "⚠️ 重做失败。")
      }
      return
    }

    if (cmd === "/share") {
      const sessionId = sessionMap.get(chatId)
      if (!sessionId) {
        await context.bot.sendMessage(chatId, "📭 没有进行中的会话。")
        return
      }
      try {
        const result = await context.opencodePost(`/session/${sessionId}/share`, undefined, chatId, true)
        const shareUrl = result?.share?.url || result?.url || result?.id
        if (shareUrl) {
          const url = shareUrl.startsWith("http") ? shareUrl : `https://opncd.ai/s/${shareUrl}`
          await context.bot.sendMessage(chatId, `🔗 <b>会话已分享！</b>\n\n${url}`, { parse_mode: "HTML" })
        } else {
          await context.bot.sendMessage(chatId, `⚠️ 分享成功但未获取到 URL。\n<code>${JSON.stringify(result)}</code>`, {
            parse_mode: "HTML",
          })
        }
      } catch {
        await context.bot.sendMessage(chatId, "⚠️ 分享失败。请检查 OpenCode 配置是否启用了分享功能。")
      }
      return
    }

    if (cmd === "/unshare") {
      const sessionId = sessionMap.get(chatId)
      if (!sessionId) {
        await context.bot.sendMessage(chatId, "📭 没有进行中的会话。")
        return
      }
      try {
        await context.opencodeDelete(`/session/${sessionId}/share`, chatId, true)
        await context.bot.sendMessage(chatId, "🔒 已取消会话分享。")
      } catch {
        await context.bot.sendMessage(chatId, "⚠️ 取消分享失败。")
      }
      return
    }

    if (cmd === "/name") {
      const sessionId = sessionMap.get(chatId)
      if (!sessionId) {
        await context.bot.sendMessage(chatId, "📭 没有进行中的会话。")
        return
      }
      if (!args) {
        await context.bot.sendMessage(chatId, "📝 用法：<code>/name 你的会话名称</code>", { parse_mode: "HTML" })
        return
      }
      try {
        await context.opencodePatch(`/session/${sessionId}`, { title: args }, chatId, true)
        await context.bot.sendMessage(chatId, `✅ 会话已重命名为：<b>${context.escapeHtml(args)}</b>`, {
          parse_mode: "HTML",
        })
      } catch {
        await context.bot.sendMessage(chatId, "⚠️ 重命名失败。")
      }
      return
    }

    if (cmd === "/status") {
      const sessionId = sessionMap.get(chatId)
      try {
        const [backendInfo, cfgData, projData, sessionDetail, messages] = await Promise.all([
          context.resolveOpencodeBackend().catch(() => null),
          context.opencodeGet("/config", chatId, true).catch(() => null),
          context.opencodeGet("/project/current", chatId, true).catch(() => null),
          sessionId ? context.opencodeGet(`/session/${sessionId}`, chatId, true).catch(() => null) : null,
          sessionId ? context.opencodeGet(`/session/${sessionId}/message`, chatId, true).catch(() => null) : null,
        ])

        const model = selectedModelMap.get(chatId) || cfgData?.model || "未知"
        const agent = selectedAgentMap.get(chatId) || (Array.isArray(messages)
          ? [...messages].reverse().find((msg: any) => typeof msg?.info?.agent === "string")?.info?.agent
          : undefined) || "build"
        const project = projData?.worktree || projData?.path || projData?.name || "未知"
        const sessionTitle = sessionDetail?.title || "未命名"
        let totalTokens = 0
        let totalInput = 0
        let totalOutput = 0
        let totalReasoning = 0
        let cacheRead = 0
        let cacheWrite = 0
        let lastTokens: any = null

        if (Array.isArray(messages)) {
          for (const msg of messages) {
            const tokens = msg?.info?.tokens
            if (tokens && msg?.info?.role === "assistant") {
              totalTokens += tokens.total || 0
              totalInput += tokens.input || 0
              totalOutput += tokens.output || 0
              totalReasoning += tokens.reasoning || 0
              cacheRead += tokens.cache?.read || 0
              cacheWrite += tokens.cache?.write || 0
              lastTokens = tokens
            }
          }
        }

        const toK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`
        const lines = [
          `📊 <b>OpenCode 状态</b>`,
          ``,
          `🤖 <b>模型：</b><code>${context.escapeHtml(model)}</code>`,
          `🧭 <b>模式：</b><code>${context.escapeHtml(agent)}</code>`,
          `📁 <b>项目：</b><code>${context.escapeHtml(project)}</code>`,
          `💬 <b>会话：</b><code>${context.escapeHtml(sessionTitle)}</code>`,
          `🔑 <b>ID：</b><code>${sessionId || "无"}</code>`,
          `💌 <b>消息数：</b>${Array.isArray(messages) ? messages.length : 0}`,
        ]

        if (backendInfo?.baseUrl) {
          lines.splice(4, 0, `🌐 <b>后端：</b><code>${context.escapeHtml(`${backendInfo.source} @ ${backendInfo.baseUrl}`)}</code>`)
        }

        if (totalTokens > 0) {
          lines.push("")
          lines.push(`📏 <b>上下文用量（累计）</b>`)
          lines.push(`├ 总 Token：<code>${toK(totalTokens)}</code>`)
          lines.push(`├ 输入：<code>${toK(totalInput)}</code>`)
          lines.push(`├ 输出：<code>${toK(totalOutput)}</code>`)
          lines.push(`├ 推理：<code>${toK(totalReasoning)}</code>`)
          if (cacheRead > 0 || cacheWrite > 0) {
            lines.push(`├ 缓存读：<code>${toK(cacheRead)}</code>`)
            lines.push(`└ 缓存写：<code>${toK(cacheWrite)}</code>`)
          } else {
            lines.push(`└ 缓存：<code>无</code>`)
          }
        }

        if (lastTokens) {
          lines.push("")
          lines.push(`📎 <b>最近一轮</b>`)
          lines.push(`├ Token：<code>${toK(lastTokens.total || 0)}</code>`)
          lines.push(`├ 输入：<code>${toK(lastTokens.input || 0)}</code>`)
          lines.push(`└ 输出：<code>${toK(lastTokens.output || 0)}</code>`)
        }

        lines.push("")
        lines.push(`💡 使用 <code>/name 名称</code> 可自定义会话标题`)
        await context.bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" })
      } catch {
        await context.bot.sendMessage(chatId, `📊 <b>快速状态</b>\n💬 <b>会话 ID：</b><code>${sessionId || "无"}</code>`, {
          parse_mode: "HTML",
        })
      }
      return
    }

    if (cmd === "/models") {
      try {
        const { providers, currentModel } = await context.getModelMenuContext(chatId)
        if (!providers.length) {
          await context.bot.sendMessage(chatId, "📭 未找到已配置的模型供应商。")
          return
        }

        const keyboard: any[][] = []
        let totalProviders = 0
        let currentRow: any[] = []
        for (const provider of providers) {
          if (!provider.models || Object.keys(provider.models).length === 0) continue
          if (totalProviders >= 50) break

          currentRow.push({
            text: context.getProviderDisplayName(provider),
            callback_data: context.createCallbackToken("provider", provider.id),
          })
          totalProviders++
          if (currentRow.length === 2) {
            keyboard.push(currentRow)
            currentRow = []
          }
        }
        if (currentRow.length > 0) keyboard.push(currentRow)

        const header = `🤖 <b>选择模型供应商</b>${currentModel ? `\n(当前使用: <code>${context.escapeHtml(currentModel)}</code>)` : ""}:`
        await context.bot.sendMessage(chatId, header, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: keyboard },
        } as any)
      } catch (error: any) {
        console.error("[/models ERROR]", error.message)
        await context.bot.sendMessage(chatId, "⚠️ 获取模型供应商列表失败。")
      }
      return
    }

    if (cmd === "/sessions") {
      try {
        const [allSessions, allProjects] = await Promise.all([
          context.opencodeGet("/session", chatId, true),
          context.listProjects().catch(() => [] as any[]),
        ])

        const explicitProjectId = activeProjectMap.get(chatId)
        const currentOcProject = await context.opencodeGet("/project/current", chatId, true).catch(() => null)
        const activeProjectId = explicitProjectId || currentOcProject?.id
        const activeProject = Array.isArray(allProjects)
          ? allProjects.find((project: any) => project.id === activeProjectId)
          : null
        const activeProjectWorktree = explicitProjectId
          ? activeProject?.worktree || explicitProjectId
          : typeof currentOcProject?.worktree === "string"
            ? currentOcProject.worktree
            : undefined
        const projectHint = activeProjectWorktree
          ? `📁 <b>当前项目：</b><code>${context.escapeHtml(context.sessionManager.getProjectDisplayName(activeProjectWorktree))}</code>  (用 /projects 切换)`
          : `(用 /projects 切换项目)`

        const sessions: any[] = Array.isArray(allSessions) ? allSessions : []
        const filtered = activeProjectWorktree
          ? sessions.filter((session: any) =>
            typeof session?.directory === "string" &&
            path.resolve(session.directory) === path.resolve(activeProjectWorktree)
          )
          : activeProjectId
            ? sessions.filter((session: any) => session.projectID === activeProjectId)
            : sessions

        if (!filtered.length) {
          await context.bot.sendMessage(
            chatId,
            `💭 <b>会话列表</b>\n${projectHint}\n\n💭 该项目下没有历史会话。\n本项目第一条消息会自动建立会话。`,
            { parse_mode: "HTML" },
          )
          return
        }

        const currentSession = sessionMap.get(chatId)
        const keyboard = filtered.slice(0, 15).map((session: any) => {
          const isActive = session.id === currentSession
          const title = (session.title || session.slug || session.id).substring(0, 28)
          const changes = session.summary?.files ? ` 📄${session.summary.files}` : ""
          return [{ text: `${isActive ? "✅ " : ""}${title}${changes}`, callback_data: context.createCallbackToken("session", session.id) }]
        })

        await context.bot.sendMessage(
          chatId,
          [
            `💬 <b>选择会话</b>  ✔️ 为当前活跃会话`,
            projectHint,
            `共 ${filtered.length} 个会话${filtered.length > 15 ? "，显示最近 15 个" : ""}`,
          ].join("\n"),
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: keyboard },
          } as any,
        )
      } catch {
        await context.bot.sendMessage(chatId, "⚠️ 获取会话列表失败。")
      }
      return
    }

    if (cmd === "/projects") {
      try {
        const projects: any[] = await context.listProjects()
        if (!projects.length) {
          await context.bot.sendMessage(chatId, "💭 没有可用的项目。")
          return
        }

        const explicitProjectId = activeProjectMap.get(chatId)
        const currentOcProject = await context.opencodeGet("/project/current", chatId, true).catch(() => null)
        const activeProjectId = explicitProjectId || currentOcProject?.id
        const followingCurrentProject = !explicitProjectId
        const keyboard: any[][] = [[{
          text: `${followingCurrentProject ? "✅ " : ""}🌐 跟随当前 OpenCode 项目`,
          callback_data: context.createCallbackToken("project", "__current__"),
        }]]
        let hiddenProjects = 0

        for (const project of projects.slice(0, 20)) {
          if (project.id === "global" || isOverlyBroadProjectWorktree(project.worktree)) {
            hiddenProjects++
            continue
          }

          const isActive = project.id === activeProjectId
          const displayPath = context.sessionManager.getProjectDisplayName(project.worktree || project.id)
          const vcsIcon = project.vcs === "git" ? " 🔀" : ""
          keyboard.push([{
            text: `${isActive ? "✅ " : ""}📁 ${displayPath}${vcsIcon}`,
            callback_data: context.createCallbackToken("project", project.id),
          }])
        }

        const currentProjDisplay = explicitProjectId
          ? context.sessionManager.getProjectDisplayName(
            projects.find((project: any) => project.id === explicitProjectId)?.worktree || explicitProjectId,
          )
          : typeof currentOcProject?.worktree === "string"
            ? context.sessionManager.getProjectDisplayName(currentOcProject.worktree)
          : "（跟随后端默认目录）"

        const projectsText = [
            `📁 <b>选择项目</b>`,
            `当前 Telegram 项目: <code>${context.escapeHtml(currentProjDisplay)}</code>`,
            ``,
            `上方按钮会直接跟随当前 OpenCode Desktop / Web 里打开的项目。`,
            `切换项目后会重置当前会话；下一条消息会在新项目下创建或继续会话。`,
            hiddenProjects > 0 ? `已隐藏 ${hiddenProjects} 个不适合作为显式目标的项目。` : ``,
            `新增项目将自动出现在此列表中。`,
          ].filter(Boolean).join("\n")
        await context.bot.sendMessage(
          chatId,
          projectsText,
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: keyboard },
          } as any,
        )
      } catch (error: any) {
        console.error("[/projects ERROR]", error?.message, error?.stack)
        await context.bot.sendMessage(chatId, "⚠️ 获取项目列表失败。")
      }
      return
    }

    if (cmd === "/commands") {
      try {
        const commands: any[] = await context.opencodeGet("/command", chatId, true)
        if (!commands.length) {
          await context.bot.sendMessage(chatId, "📭 没有可用的自定义命令。")
          return
        }

        const keyboard = commands.slice(0, 20).map((command: any) => [{
          text: `/${command.name || command.id || "unknown"}${command.description ? ` — ${command.description}` : ""}`,
          callback_data: context.createCallbackToken("command", command.name || command.id || "unknown"),
        }])

        await context.bot.sendMessage(chatId, "📋 <b>所有可用命令：</b>（点击执行）", {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: keyboard },
        } as any)
      } catch {
        await context.bot.sendMessage(chatId, "⚠️ 获取命令列表失败。")
      }
      return
    }

    if (commandInput) {
      if (context.streaming.hasActiveResponse(chatId)) {
        await context.bot.sendMessage(chatId, "⏳ 当前正在处理上一条消息，请等待回复，或发送 /stop 后再执行新命令。")
        return
      }
      try {
        await context.streaming.dispatchCustomCommand(chatId, normalized, cmd, args)
      } catch (error) {
        context.streaming.clearResponseTracking(chatId)
        context.streaming.stopTypingIndicator(chatId)
        await context.bot.sendMessage(chatId, `⚠️ 错误: ${context.formatUserFacingError(error)}`)
      }
      return
    }

    if (context.streaming.hasActiveResponse(chatId)) {
      await context.bot.sendMessage(chatId, "⏳ 当前正在处理上一条消息，请等待回复，或发送 /stop 后再发送新内容。")
      return
    }

    try {
      await context.streaming.dispatchPromptMessage(chatId, normalized)
    } catch (error) {
      context.streaming.clearResponseTracking(chatId)
      context.streaming.stopTypingIndicator(chatId)
      await context.bot.sendMessage(chatId, `⚠️ 错误: ${context.formatUserFacingError(error)}`)
    }
  }
}
