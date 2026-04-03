import { escapeHtml } from "@matincz/telegram-bot-core/telegram/rendering"
import type { ResolvedTelegramAttachment } from "../telegram/types"

export type ExecutionApprovalMode = "auto" | "prompt"

export interface PendingExecutionApproval {
  token: string
  chatId: number
  userText: string
  attachments: ResolvedTelegramAttachment[]
  createdAt: number
}

const pendingApprovals = new Map<string, PendingExecutionApproval>()
const pendingByChat = new Map<number, string>()

let tokenCounter = 0

export function createApprovalToken() {
  return `codex_${Date.now().toString(36)}${(tokenCounter++).toString(36)}`
}

export function setPendingApproval(approval: PendingExecutionApproval) {
  const existingToken = pendingByChat.get(approval.chatId)
  const replaced = existingToken ? pendingApprovals.get(existingToken) ?? null : null
  if (existingToken) {
    pendingApprovals.delete(existingToken)
  }
  pendingApprovals.set(approval.token, approval)
  pendingByChat.set(approval.chatId, approval.token)
  return replaced
}

export function getPendingApproval(token: string) {
  return pendingApprovals.get(token) ?? null
}

export function hasPendingApproval(chatId: number) {
  return pendingByChat.has(chatId)
}

export function clearPendingApproval(chatId: number) {
  const token = pendingByChat.get(chatId)
  if (!token) return null
  pendingByChat.delete(chatId)
  const approval = pendingApprovals.get(token) ?? null
  pendingApprovals.delete(token)
  return approval
}

export function buildExecutionApprovalMessage(input: {
  token: string
  userText: string
  model: string
  effort: string
  permissionMode: string
  attachments: ResolvedTelegramAttachment[]
}) {
  const lines = [
    "🛂 <b>执行审批</b>",
    "",
    `模型：<code>${escapeHtml(input.model)}</code>`,
    `推理强度：<code>${escapeHtml(input.effort)}</code>`,
    `权限模式：<code>${escapeHtml(input.permissionMode)}</code>`,
  ]

  if (input.userText.trim()) {
    lines.push("", "<b>请求：</b>")
    lines.push(`<blockquote expandable>${escapeHtml(input.userText.trim()).slice(0, 2000)}</blockquote>`)
  }

  if (input.attachments.length > 0) {
    lines.push("", "<b>附件：</b>")
    for (const attachment of input.attachments.slice(0, 6)) {
      lines.push(`• <code>${escapeHtml(attachment.filename)}</code> (${escapeHtml(attachment.mime)})`)
    }
  }

  lines.push("", "是否执行这次 Codex 请求？")

  return {
    text: lines.join("\n"),
    options: {
      parse_mode: "HTML" as const,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ 执行一次", callback_data: `codex-approve:run:${input.token}` },
            { text: "✅✅ 总是允许", callback_data: `codex-approve:always:${input.token}` },
            { text: "❌ 拒绝", callback_data: `codex-approve:reject:${input.token}` },
          ],
        ],
      },
    },
  }
}
