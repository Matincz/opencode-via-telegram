import type { BotContext } from "./bot-context"
import { answerCallbackQuerySafe, editMessageTextSafe } from "@matincz/telegram-bot-core/telegram/callback"
import { logError } from "../runtime/logger"
import {
  clearPendingApproval,
  getPendingApproval,
} from "../gemini/approval"
import {
  chatHistoryMap,
  clearChatSession,
  saveChatHistories,
  saveSessions,
  setChatSession,
} from "../store/runtime-state"
import {
  setApprovalRuntimeConfig,
} from "../store/approval-runtime"
import {
  deleteCheckpoint,
  getCheckpointById,
  getRewindSnapshotById,
  listCheckpoints,
  listRewindSnapshots,
} from "../store/snapshots"
import {
  updatePlanArtifact,
} from "../store/plan-artifacts"
import {
  setToolApprovalPreference,
} from "../store/tool-approval"
import { buildCheckpointPickerMessage } from "./checkpoint-picker"
import { buildPlanModePickerMessage } from "./plan-mode-picker"
import { buildRewindPickerMessage } from "./rewind-picker"
import { buildSandboxModePickerMessage } from "./sandbox-mode-picker"
import { buildSessionPickerMessage } from "./session-picker"
import { renderTodoProgressHtml } from "./plan-status"
import { isGeminiAbortError, preserveGeminiSessionFromError, formatGeminiFailureMessage } from "../gemini/turn-runner"
import { listGeminiSessions, resolveGeminiSessionIdentifier, deleteGeminiSession } from "../gemini/sessions"
import { scheduleAttachmentCleanup } from "./media"

export async function handleCallbackQuery(
  ctx: BotContext,
  query: any,
): Promise<void> {
  const data = String(query?.data || "")

  const chatId = query?.message?.chat?.id
  const messageId = query?.message?.message_id
  const userId = query?.from?.id

  if (!chatId || !messageId) {
    await answerCallbackQuerySafe(ctx.bot, query.id, { text: "⚠️ 无法识别当前聊天。", show_alert: false })
    return
  }

  if (ctx.allowedUserId !== "ALL" && String(userId) !== ctx.allowedUserId) {
    await answerCallbackQuerySafe(ctx.bot, query.id, { text: "🚫 未授权访客。", show_alert: true })
    return
  }

  if (data.startsWith("session:resume:")) {
    const sessionId = data.slice("session:resume:".length)
    setChatSession(chatId, sessionId)
    saveSessions()
    chatHistoryMap.delete(chatId)
    saveChatHistories()

    const sessions = await listGeminiSessions({ geminiBin: ctx.geminiBin, cwd: ctx.geminiCwd || process.cwd() })
    const picker = buildSessionPickerMessage(sessions, sessionId)
    await answerCallbackQuerySafe(ctx.bot, query.id, { text: `已恢复会话 ${sessionId.slice(0, 8)}` })
    await editMessageTextSafe(ctx.bot, chatId, messageId, picker.text, picker.options)
    return
  }

  if (data.startsWith("session:delete:")) {
    const identifier = data.slice("session:delete:".length)
    const currentSessionId = ctx.getNativeResumeSession(chatId)
    const sessions = await listGeminiSessions({ geminiBin: ctx.geminiBin, cwd: ctx.geminiCwd || process.cwd() })
    const target = resolveGeminiSessionIdentifier(sessions, identifier)

    await deleteGeminiSession({
      geminiBin: ctx.geminiBin,
      identifier,
      cwd: ctx.geminiCwd || process.cwd(),
    })

    if (target && currentSessionId === target.sessionId) {
      clearChatSession(chatId)
    }

    const nextSessions = await listGeminiSessions({ geminiBin: ctx.geminiBin, cwd: ctx.geminiCwd || process.cwd() })
    await answerCallbackQuerySafe(ctx.bot, query.id, { text: `已删除会话 ${identifier}` })

    if (nextSessions.length === 0) {
      await editMessageTextSafe(ctx.bot, chatId, messageId, "📭 当前项目还没有 Gemini 原生会话。")
      return
    }

    const picker = buildSessionPickerMessage(nextSessions, ctx.getNativeResumeSession(chatId))
    await editMessageTextSafe(ctx.bot, chatId, messageId, picker.text, picker.options)
    return
  }

  if (data.startsWith("planmode:")) {
    const action = data.slice("planmode:".length)
    const currentMode = ctx.getToolApprovalStrategy(chatId) === "plan_then_execute"
    const nextEnabled =
      action === "toggle" ? !currentMode
        : action === "on" ? true
          : action === "off" ? false
            : null

    if (nextEnabled === null) {
      await answerCallbackQuerySafe(ctx.bot, query.id, { text: "⚠️ 无法识别的计划模式动作。", show_alert: false })
      return
    }

    setApprovalRuntimeConfig(chatId, {
      strategy: nextEnabled ? "plan_then_execute" : "notify",
    })

    const picker = buildPlanModePickerMessage(nextEnabled)
    await answerCallbackQuerySafe(ctx.bot, query.id, { text: nextEnabled ? "✅ Plan mode 已开启" : "✅ Plan mode 已关闭" })
    await editMessageTextSafe(ctx.bot, chatId, messageId, picker.text, picker.options)
    return
  }

  if (data.startsWith("sandboxmode:")) {
    const action = data.slice("sandboxmode:".length)
    const currentMode = ctx.getResolvedApprovalRuntime(chatId).sandbox
    const nextEnabled =
      action === "toggle" ? !currentMode
        : action === "on" ? true
          : action === "off" ? false
            : null

    if (nextEnabled === null) {
      await answerCallbackQuerySafe(ctx.bot, query.id, { text: "⚠️ 无法识别的沙箱动作。", show_alert: false })
      return
    }

    setApprovalRuntimeConfig(chatId, { sandbox: nextEnabled })

    const picker = buildSandboxModePickerMessage(nextEnabled)
    await answerCallbackQuerySafe(ctx.bot, query.id, { text: nextEnabled ? "✅ Sandbox 已开启" : "✅ Sandbox 已关闭" })
    await editMessageTextSafe(ctx.bot, chatId, messageId, picker.text, picker.options)
    return
  }

  if (data.startsWith("checkpoint:restore:")) {
    const checkpointId = data.slice("checkpoint:restore:".length)
    const checkpoint = getCheckpointById(chatId, checkpointId)
    if (!checkpoint) {
      await answerCallbackQuerySafe(ctx.bot, query.id, { text: "⚠️ checkpoint 不存在。", show_alert: false })
      return
    }

    ctx.restoreStoredSnapshot(chatId, checkpoint)
    const picker = buildCheckpointPickerMessage(listCheckpoints(chatId))
    await answerCallbackQuerySafe(ctx.bot, query.id, { text: `已恢复 ${checkpoint.title}` })
    await editMessageTextSafe(ctx.bot, chatId, messageId, picker.text, picker.options)
    return
  }

  if (data.startsWith("checkpoint:delete:")) {
    const checkpointId = data.slice("checkpoint:delete:".length)
    const checkpoint = getCheckpointById(chatId, checkpointId)
    if (!checkpoint) {
      await answerCallbackQuerySafe(ctx.bot, query.id, { text: "⚠️ checkpoint 不存在。", show_alert: false })
      return
    }

    deleteCheckpoint(chatId, checkpointId)
    const nextCheckpoints = listCheckpoints(chatId)
    await answerCallbackQuerySafe(ctx.bot, query.id, { text: `已删除 ${checkpoint.title}` })
    if (nextCheckpoints.length === 0) {
      await editMessageTextSafe(ctx.bot, chatId, messageId, "📭 当前聊天还没有保存的 checkpoint。")
      return
    }

    const picker = buildCheckpointPickerMessage(nextCheckpoints)
    await editMessageTextSafe(ctx.bot, chatId, messageId, picker.text, picker.options)
    return
  }

  if (data.startsWith("gplan:")) {
    const parts = data.split(":")
    const action = parts[1]
    const planToken = parts.slice(2).join(":")
    const approval = getPendingApproval(planToken)

    if (!approval) {
      await answerCallbackQuerySafe(ctx.bot, query.id, { text: "⚠️ 审批请求已过期或已处理。", show_alert: false })
      return
    }

    if (action === "once" || action === "always") {
      if (action === "always") {
        setToolApprovalPreference(chatId, "always")
      }
      clearPendingApproval(chatId)
      const approvedArtifact = updatePlanArtifact(chatId, approval.artifactId, { status: "approved" })
      await answerCallbackQuerySafe(ctx.bot, query.id, { text: action === "always" ? "✅ 已总是允许，开始执行..." : "✅ 已允许本次执行..." })
      await editMessageTextSafe(
        ctx.bot,
        chatId,
        messageId,
        action === "always"
          ? `✅ <b>已允许（总是）</b>\n\n正在执行计划...\n\n${approvedArtifact ? renderTodoProgressHtml(approvedArtifact) : ""}`
          : `✅ <b>已允许（本次）</b>\n\n正在执行计划...\n\n${approvedArtifact ? renderTodoProgressHtml(approvedArtifact) : ""}`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } },
      )

      try {
        await ctx.turnRunner.runExecutionPhase(chatId, approval.userText, approval.planText, approval.planSessionId, approval.attachments, approval.artifactId)
      } catch (error) {
        if (isGeminiAbortError(error)) return
        preserveGeminiSessionFromError(chatId, error)
        updatePlanArtifact(chatId, approval.artifactId, { status: "failed", errorMessage: error instanceof Error ? error.message : String(error) })
        logError("TG.GEMINI.EXECUTE_FAILED", { chatId, planToken }, error)
        const message = formatGeminiFailureMessage(error, "⚠️ 执行失败：")
        await ctx.bot.sendMessage(chatId, message).catch(() => { })
      } finally {
        scheduleAttachmentCleanup(approval.attachments.map((a) => a.path))
      }
      return
    }

    if (action === "reject") {
      clearPendingApproval(chatId)
      updatePlanArtifact(chatId, approval.artifactId, { status: "rejected" })
      scheduleAttachmentCleanup(approval.attachments.map((a) => a.path))
      await answerCallbackQuerySafe(ctx.bot, query.id, { text: "❌ 已拒绝" })
      await editMessageTextSafe(ctx.bot, chatId, messageId, `❌ <b>计划已拒绝</b>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } })
      return
    }

    if (action === "revise") {
      clearPendingApproval(chatId)
      updatePlanArtifact(chatId, approval.artifactId, { status: "rejected", errorMessage: "用户要求修改计划" })
      scheduleAttachmentCleanup(approval.attachments.map((a) => a.path))
      await answerCallbackQuerySafe(ctx.bot, query.id, { text: "✏️ 请发送修改意见" })
      await editMessageTextSafe(ctx.bot, chatId, messageId, `✏️ <b>请发送修改意见，将重新生成计划</b>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } })
      return
    }

    await answerCallbackQuerySafe(ctx.bot, query.id)
    return
  }

  if (data.startsWith("rewind:restore:")) {
    const snapshotId = data.slice("rewind:restore:".length)
    const snapshot = getRewindSnapshotById(chatId, snapshotId)
    if (!snapshot) {
      await answerCallbackQuerySafe(ctx.bot, query.id, { text: "⚠️ rewind 快照不存在。", show_alert: false })
      return
    }

    ctx.restoreStoredSnapshot(chatId, snapshot)
    const picker = buildRewindPickerMessage(listRewindSnapshots(chatId))
    await answerCallbackQuerySafe(ctx.bot, query.id, { text: `已恢复 ${snapshot.title}` })
    await editMessageTextSafe(ctx.bot, chatId, messageId, picker.text, picker.options)
    return
  }

  if (!data.startsWith("model:")) return

  const model = data.slice("model:".length)

  if (model === "__native_default__") {
    await ctx.clearSessionModelOverride(chatId)
    const picker = ctx.getModelPicker(chatId)
    await answerCallbackQuerySafe(ctx.bot, query.id, { text: `已恢复到原生默认模型` })
    await editMessageTextSafe(ctx.bot, chatId, messageId, picker.text, picker.options)
    return
  }

  const currentModel = ctx.getEffectiveModel(chatId)
  if (currentModel === model) {
    await answerCallbackQuerySafe(ctx.bot, query.id, { text: `当前已经是 ${model}` })
    return
  }

  const switched = await ctx.switchModel(chatId, model, false)
  if (!switched) {
    await answerCallbackQuerySafe(ctx.bot, query.id, { text: "⚠️ 切换失败。", show_alert: false })
    return
  }

  const picker = ctx.getModelPicker(chatId)
  await answerCallbackQuerySafe(ctx.bot, query.id, { text: `已切换到 ${model}` })
  const updated = await editMessageTextSafe(ctx.bot, chatId, messageId, picker.text, picker.options)
  if (!updated) {
    await ctx.bot.sendMessage(chatId, `✅ 当前模型已切换为：${model}`).catch(() => { })
  }
}
