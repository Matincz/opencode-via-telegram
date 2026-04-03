import type { BotContext } from "./bot-context"
import { logInfo, logError } from "../runtime/logger"
import { getGeminiConfigSnapshot } from "../gemini/mcp"
import {
  clearPendingApproval,
  getPendingApprovalForChat,
  hasPendingApproval,
} from "../gemini/approval"
import {
  chatHistoryMap,
  clearChatSession,
  getChatHistory,
  saveChatHistories,
  saveSessions,
  setChatSession,
} from "../store/runtime-state"
import {
  clearApprovalRuntimeConfig,
  setApprovalRuntimeConfig,
} from "../store/approval-runtime"
import {
  deleteCheckpoint,
  listCheckpoints,
  pushRewindSnapshot,
  saveCheckpoint,
} from "../store/snapshots"
import {
  getLatestPlanArtifact,
  listPlanArtifacts,
  updatePlanArtifact,
} from "../store/plan-artifacts"
import {
  clearToolApprovalPreference,
  getToolApprovalPreference,
} from "../store/tool-approval"
import { renderMcpStatusHtml, renderPlanArtifactHtml, renderToolsStatusHtml } from "./plan-status"
import { buildPlanModePickerMessage } from "./plan-mode-picker"
import { buildSandboxModePickerMessage } from "./sandbox-mode-picker"
import { deleteGeminiSession, listGeminiSessions, resolveGeminiSessionIdentifier } from "../gemini/sessions"
import type { GeminiExecutionMode } from "../store/approval-runtime"

export async function handleCommand(
  ctx: BotContext,
  chatId: number,
  command: { cmd: string; args: string },
): Promise<boolean> {
  if (command.cmd === "/new") {
    clearChatSession(chatId)
    await ctx.clearSessionModelOverride(chatId)
    await ctx.bot.sendMessage(chatId, "♻️ Gemini 会话已重置。").catch(() => { })
    return true
  }

  if (command.cmd === "/status") {
    const historySize = getChatHistory(chatId).length
    const approvalRuntime = ctx.getResolvedApprovalRuntime(chatId)
    const sandboxLabel = approvalRuntime.sandbox ? "on" : "off"
    const pendingPlan = hasPendingApproval(chatId)
    const approvalPreference = getToolApprovalPreference(chatId)
    const latestPlan = getLatestPlanArtifact(chatId)
    await ctx.bot.sendMessage(
      chatId,
      [
        "<b>Gemini CLI via Telegram</b>",
        `当前选择：<code>${ctx.getEffectiveModel(chatId) || "Gemini CLI 默认"}</code>`,
        `最近一次实际模型：<code>${ctx.lastResolvedModelMap.get(chatId) || "暂无"}</code>`,
        `最近一次计划模型：<code>${ctx.lastPlanResolvedModelMap.get(chatId) || "暂无"}</code>`,
        `规划模型：<code>${ctx.getPlanModel(chatId) || "Gemini CLI 默认"}</code>`,
        `执行模型：<code>${ctx.getExecutionModel(chatId) || "Gemini CLI 默认"}</code>`,
        `会话覆盖：<code>${ctx.getSessionModelOverride(chatId) || "无"}</code>`,
        `原生默认：<code>${ctx.persistedGeminiModel || "Gemini CLI 默认"}</code>`,
        `当前会话：<code>${ctx.getNativeResumeSession(chatId) || "未建立"}</code>`,
        `历史条目：<code>${historySize}</code>`,
        `审批策略：<code>${approvalRuntime.strategy}</code>`,
        `计划模式：<code>${approvalRuntime.strategy === "plan_then_execute" ? "on" : "off"}</code>`,
        `聊天偏好：<code>${approvalPreference === "always" ? "总是允许" : "每次询问"}</code>`,
        `执行模式：<code>${approvalRuntime.executionMode}</code>`,
        `沙箱模式：<code>${sandboxLabel}</code>`,
        `待审批计划：<code>${pendingPlan ? "有" : "无"}</code>`,
        `最近计划：<code>${latestPlan ? `${latestPlan.id} / ${latestPlan.status}` : "暂无"}</code>`,
        `网络重试：<code>${ctx.geminiRetryFetchErrors ? `on / ${ctx.geminiMaxAttempts} 次` : "off"}</code>`,
        `CLI Home：<code>${ctx.geminiCliHome}</code>`,
      ].join("\n"),
      { parse_mode: "HTML" },
    ).catch(() => { })
    return true
  }

  if (command.cmd === "/approval") {
    const rawArgs = command.args.trim()
    const runtime = ctx.getResolvedApprovalRuntime(chatId)
    if (!rawArgs) {
      await ctx.bot.sendMessage(
        chatId,
        [
          "<b>工具审批策略</b>",
          "",
          `当前策略：<code>${runtime.strategy}</code>`,
          `计划模式：<code>${runtime.strategy === "plan_then_execute" ? "on" : "off"}</code>`,
          `当前聊天偏好：<code>${getToolApprovalPreference(chatId) === "always" ? "总是允许" : "每次询问"}</code>`,
          `执行模式：<code>${runtime.executionMode}</code>`,
          `沙箱：<code>${runtime.sandbox ? "on" : "off"}</code>`,
          "",
          "<b>可用策略：</b>",
          "• <code>notify</code> — 直接执行，工具调用仅通知",
          "• <code>plan_then_execute</code> — 先生成计划，审批后再执行",
          "",
          "可用命令：",
          "• <code>/plan_mode on|off|toggle|status</code>",
          "• <code>/sandbox_mode on|off|toggle|status</code>",
          "• <code>/approval mode notify</code>",
          "• <code>/approval mode plan_then_execute</code>",
          "• <code>/approval yolo on|off</code>",
          "• <code>/approval sandbox on|off</code>",
          "• <code>/approval reset</code> 清除\u201c总是允许\u201d",
          "• <code>/approval defaults</code> 恢复默认策略",
          "",
          "通过环境变量 <code>TG_TOOL_APPROVAL_STRATEGY</code> 配置。",
        ].join("\n"),
        { parse_mode: "HTML" },
      ).catch(() => { })
      return true
    }

    if (rawArgs === "cancel") {
      const pendingApproval = getPendingApprovalForChat(chatId)
      if (!pendingApproval) {
        await ctx.bot.sendMessage(chatId, "📭 当前没有待审批的计划。").catch(() => { })
        return true
      }
      clearPendingApproval(chatId)
      updatePlanArtifact(chatId, pendingApproval.artifactId, { status: "rejected", errorMessage: "审批已取消" })
      await ctx.bot.sendMessage(chatId, "❌ 已取消待审批计划。").catch(() => { })
      return true
    }

    if (rawArgs === "reset") {
      const cleared = clearToolApprovalPreference(chatId)
      await ctx.bot.sendMessage(chatId, cleared ? "♻️ 已恢复为每次询问审批。" : "ℹ️ 当前聊天本来就是每次询问。").catch(() => { })
      return true
    }

    if (rawArgs === "defaults") {
      clearApprovalRuntimeConfig(chatId)
      await ctx.bot.sendMessage(chatId, "♻️ 已恢复默认审批策略、执行模式和沙箱设置。").catch(() => { })
      return true
    }

    const [action = "", value = ""] = rawArgs.split(/\s+/, 2)
    if (action === "mode" && (value === "notify" || value === "plan_then_execute")) {
      setApprovalRuntimeConfig(chatId, { strategy: value })
      await ctx.bot.sendMessage(chatId, `✅ 审批策略已切换为：${value}`).catch(() => { })
      return true
    }

    if (action === "yolo" && (value === "on" || value === "off")) {
      const configSnapshot = getGeminiConfigSnapshot({ rootDir: ctx.rootDir, cliHome: ctx.geminiCliHome })
      const executionMode: GeminiExecutionMode = value === "on" ? "yolo" : "default"
      setApprovalRuntimeConfig(chatId, { executionMode })
      const suffix = value === "on" && configSnapshot.yoloDisabled ? "；注意：当前 Gemini 配置声明禁用 yolo" : ""
      await ctx.bot.sendMessage(chatId, `✅ 执行模式已切换为：${executionMode}${suffix}`).catch(() => { })
      return true
    }

    if (action === "sandbox" && (value === "on" || value === "off")) {
      setApprovalRuntimeConfig(chatId, { sandbox: value === "on" })
      await ctx.bot.sendMessage(chatId, `✅ 沙箱已${value === "on" ? "开启" : "关闭"}。`).catch(() => { })
      return true
    }

    await ctx.bot.sendMessage(chatId, "📝 用法：/approval | /approval cancel | /approval reset | /approval defaults | /approval mode notify|plan_then_execute | /approval yolo on|off | /approval sandbox on|off").catch(() => { })
    return true
  }

  if (command.cmd === "/plan_mode") {
    const rawArgs = command.args.trim().toLowerCase()
    const currentMode = ctx.getToolApprovalStrategy(chatId) === "plan_then_execute"
    const sendStatus = async () => {
      const picker = buildPlanModePickerMessage(currentMode)
      return ctx.bot.sendMessage(chatId, picker.text, picker.options).catch(() => { })
    }

    if (!rawArgs || rawArgs === "status") {
      await sendStatus()
      return true
    }

    const nextEnabled = rawArgs === "toggle" ? !currentMode : rawArgs === "on"
    if (rawArgs !== "on" && rawArgs !== "off" && rawArgs !== "toggle") {
      await ctx.bot.sendMessage(chatId, "📝 用法：/plan_mode on|off|toggle|status").catch(() => { })
      return true
    }

    setApprovalRuntimeConfig(chatId, {
      strategy: nextEnabled ? "plan_then_execute" : "notify",
    })
    await ctx.bot.sendMessage(
      chatId,
      nextEnabled
        ? "✅ 计划模式已开启。后续 agent 请求会先出计划，再在 Telegram 审批。"
        : "✅ 计划模式已关闭。后续请求默认直接执行，不先走计划审批。",
    ).catch(() => { })
    return true
  }

  if (command.cmd === "/sandbox_mode") {
    const rawArgs = command.args.trim().toLowerCase()
    const currentMode = ctx.getResolvedApprovalRuntime(chatId).sandbox
    const sendStatus = async () => {
      const picker = buildSandboxModePickerMessage(currentMode)
      return ctx.bot.sendMessage(chatId, picker.text, picker.options).catch(() => { })
    }

    if (!rawArgs || rawArgs === "status") {
      await sendStatus()
      return true
    }

    const nextEnabled = rawArgs === "toggle" ? !currentMode : rawArgs === "on"
    if (rawArgs !== "on" && rawArgs !== "off" && rawArgs !== "toggle") {
      await ctx.bot.sendMessage(chatId, "📝 用法：/sandbox_mode on|off|toggle|status").catch(() => { })
      return true
    }

    setApprovalRuntimeConfig(chatId, { sandbox: nextEnabled })
    await ctx.bot.sendMessage(
      chatId,
      nextEnabled
        ? "✅ 沙箱模式已开启。后续执行阶段会启用沙箱。"
        : "✅ 沙箱模式已关闭。后续执行阶段不启用沙箱。",
    ).catch(() => { })
    return true
  }

  if (command.cmd === "/plan") {
    const rawArgs = command.args.trim()
    if (rawArgs === "list") {
      const artifacts = listPlanArtifacts(chatId).slice(-8).reverse()
      if (artifacts.length === 0) {
        await ctx.bot.sendMessage(chatId, "📭 当前聊天还没有计划产物。").catch(() => { })
        return true
      }
      const message = [
        "<b>最近计划列表</b>",
        ...artifacts.map((artifact) => `• <code>${artifact.id}</code> — <code>${artifact.status}</code> — ${artifact.createdAt}`),
      ].join("\n")
      await ctx.bot.sendMessage(chatId, message, { parse_mode: "HTML" }).catch(() => { })
      return true
    }

    const artifact = rawArgs
      ? listPlanArtifacts(chatId).find((item) => item.id === rawArgs || item.id.startsWith(rawArgs))
      : getLatestPlanArtifact(chatId)

    if (!artifact) {
      await ctx.bot.sendMessage(chatId, "📭 当前聊天还没有计划产物。").catch(() => { })
      return true
    }

    await ctx.bot.sendMessage(chatId, renderPlanArtifactHtml(artifact), { parse_mode: "HTML" }).catch(() => { })
    return true
  }

  if (command.cmd === "/mcp") {
    const snapshot = getGeminiConfigSnapshot({ rootDir: ctx.rootDir, cliHome: ctx.geminiCliHome })
    await ctx.bot.sendMessage(chatId, renderMcpStatusHtml(snapshot), { parse_mode: "HTML" }).catch(() => { })
    return true
  }

  if (command.cmd === "/tools") {
    const snapshot = getGeminiConfigSnapshot({ rootDir: ctx.rootDir, cliHome: ctx.geminiCliHome })
    const latestPlan = getLatestPlanArtifact(chatId)
    await ctx.bot.sendMessage(chatId, renderToolsStatusHtml(snapshot, latestPlan?.toolSummary || []), { parse_mode: "HTML" }).catch(() => { })
    return true
  }

  if (command.cmd === "/sessions") {
    await ctx.sendSessionPicker(chatId)
    return true
  }

  if (command.cmd === "/checkpoints") {
    await ctx.sendCheckpointPicker(chatId)
    return true
  }

  if (command.cmd === "/checkpoint") {
    const rawArgs = command.args.trim()
    if (!rawArgs) {
      await ctx.bot.sendMessage(chatId, "📝 用法：/checkpoint save 名称 | /checkpoint resume 名称 | /checkpoint delete 名称").catch(() => { })
      return true
    }

    const [action = "", ...restArgs] = rawArgs.split(/\s+/)
    const title = restArgs.join(" ").trim()

    if (action === "save") {
      if (!title) {
        await ctx.bot.sendMessage(chatId, "📝 用法：/checkpoint save 名称").catch(() => { })
        return true
      }

      const snapshot = saveCheckpoint(chatId, title, getChatHistory(chatId), ctx.getEffectiveModel(chatId) || null)
      pushRewindSnapshot(chatId, {
        title: `checkpoint: ${snapshot.title}`,
        history: snapshot.history,
        model: snapshot.model,
      })
      await ctx.bot.sendMessage(chatId, `📌 已保存 checkpoint：${snapshot.title}`).catch(() => { })
      return true
    }

    if (action === "resume") {
      if (!title) {
        await ctx.bot.sendMessage(chatId, "📝 用法：/checkpoint resume 名称").catch(() => { })
        return true
      }

      const checkpoint = listCheckpoints(chatId).find((item) => item.title === title)
      if (!checkpoint) {
        await ctx.bot.sendMessage(chatId, `⚠️ 找不到 checkpoint：${title}`).catch(() => { })
        return true
      }

      ctx.restoreStoredSnapshot(chatId, checkpoint)
      await ctx.bot.sendMessage(chatId, `↺ 已恢复 checkpoint：${checkpoint.title}`).catch(() => { })
      return true
    }

    if (action === "delete") {
      if (!title) {
        await ctx.bot.sendMessage(chatId, "📝 用法：/checkpoint delete 名称").catch(() => { })
        return true
      }

      const checkpoint = listCheckpoints(chatId).find((item) => item.title === title)
      if (!checkpoint) {
        await ctx.bot.sendMessage(chatId, `⚠️ 找不到 checkpoint：${title}`).catch(() => { })
        return true
      }

      deleteCheckpoint(chatId, checkpoint.id)
      await ctx.bot.sendMessage(chatId, `🗑 已删除 checkpoint：${checkpoint.title}`).catch(() => { })
      return true
    }

    await ctx.bot.sendMessage(chatId, "📝 用法：/checkpoint save 名称 | /checkpoint resume 名称 | /checkpoint delete 名称").catch(() => { })
    return true
  }

  if (command.cmd === "/rewind") {
    await ctx.sendRewindPicker(chatId)
    return true
  }

  if (command.cmd === "/resume") {
    if (!command.args.trim()) {
      await ctx.bot.sendMessage(chatId, "📝 用法：/resume latest 或 /resume 23").catch(() => { })
      return true
    }

    const sessions = await listGeminiSessions({ geminiBin: ctx.geminiBin, cwd: ctx.geminiCwd || process.cwd() })
    const resolved = resolveGeminiSessionIdentifier(sessions, command.args.trim())
    if (!resolved) {
      await ctx.bot.sendMessage(chatId, `⚠️ 找不到会话：${command.args.trim()}`).catch(() => { })
      return true
    }

    setChatSession(chatId, resolved.sessionId)
    saveSessions()
    chatHistoryMap.delete(chatId)
    saveChatHistories()
    await ctx.bot.sendMessage(chatId, `✅ 已切换到 Gemini 原生会话：${resolved.index} / ${resolved.sessionId}`).catch(() => { })
    return true
  }

  if (command.cmd === "/delete_session") {
    if (!command.args.trim()) {
      await ctx.bot.sendMessage(chatId, "📝 用法：/delete_session 23").catch(() => { })
      return true
    }

    const result = await deleteGeminiSession({
      geminiBin: ctx.geminiBin,
      identifier: command.args.trim(),
      cwd: process.cwd(),
    })
    await ctx.bot.sendMessage(chatId, `🗑 ${result}`).catch(() => { })
    return true
  }

  if (command.cmd === "/models") {
    await ctx.sendModelPicker(chatId)
    return true
  }

  if (command.cmd === "/model") {
    const rawArgs = command.args.trim()
    if (!rawArgs || rawArgs === "manage") {
      await ctx.sendModelPicker(chatId)
      return true
    }

    if (rawArgs === "default" || rawArgs === "clear") {
      await ctx.clearSessionModelOverride(chatId)
      await ctx.bot.sendMessage(chatId, `✅ 已恢复到原生默认模型：${ctx.persistedGeminiModel || "Gemini CLI 默认"}`).catch(() => { })
      return true
    }

    const normalizedArgs = rawArgs.startsWith("set ") ? rawArgs.slice(4).trim() : rawArgs
    const persist = normalizedArgs.includes("--persist")
    const model = normalizedArgs.replace(/\s+--persist\b/g, "").trim()
    const switched = await ctx.switchModel(chatId, model, persist)
    if (!switched) {
      return true
    }

    await ctx.bot.sendMessage(
      chatId,
      persist
        ? `✅ 当前模型已切换为：${model}（已写入 Gemini CLI 原生设置）`
        : `✅ 当前会话模型已切换为：${model}`,
    ).catch(() => { })
    return true
  }

  if (command.cmd === "/stop") {
    const controller = ctx.activeResponses.get(chatId)
    const hadPending = hasPendingApproval(chatId)
    const pendingApproval = hadPending ? getPendingApprovalForChat(chatId) : null

    if (hadPending) {
      clearPendingApproval(chatId)
      if (pendingApproval) {
        updatePlanArtifact(chatId, pendingApproval.artifactId, { status: "rejected", errorMessage: "用户已中止待审批计划" })
      }
    }

    if (!controller && !hadPending) {
      await ctx.bot.sendMessage(chatId, "📭 当前没有进行中的响应。").catch(() => { })
      return true
    }

    if (controller) {
      controller.abort()
    }
    ctx.activeResponses.delete(chatId)
    ctx.stopTyping(chatId)
    ctx.clearActiveDraft(chatId)

    await ctx.bot.sendMessage(
      chatId,
      hadPending ? "⛔ 已取消待审批计划并中止响应。" : "⛔ 已请求中止当前 Gemini 响应。",
    ).catch(() => { })
    return true
  }

  return false
}
