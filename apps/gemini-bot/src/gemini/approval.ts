import type { ResolvedTelegramAttachment } from "../telegram/types"
import { formatGeminiAttachmentReference } from "./attachment-paths"

export type ToolApprovalStrategy = "notify" | "plan_then_execute"

export interface PendingPlanApproval {
  token: string
  chatId: number
  artifactId: string
  planSessionId?: string
  messageId?: number
  userText: string
  planText: string
  toolSummary: string[]
  model?: string
  includeDirectories: string[]
  attachments: ResolvedTelegramAttachment[]
  createdAt: number
}

const pendingApprovals = new Map<string, PendingPlanApproval>()
const pendingByChat = new Map<number, string>()

let tokenCounter = 0

export function createApprovalToken() {
  return `gplan_${Date.now().toString(36)}${(tokenCounter++).toString(36)}`
}

export function setPendingApproval(approval: PendingPlanApproval) {
  const existing = pendingByChat.get(approval.chatId)
  if (existing) {
    pendingApprovals.delete(existing)
  }
  pendingApprovals.set(approval.token, approval)
  pendingByChat.set(approval.chatId, approval.token)
}

export function getPendingApproval(token: string) {
  return pendingApprovals.get(token) ?? null
}

export function getPendingApprovalForChat(chatId: number) {
  const token = pendingByChat.get(chatId)
  return token ? pendingApprovals.get(token) ?? null : null
}

export function clearPendingApproval(chatId: number) {
  const token = pendingByChat.get(chatId)
  if (token) {
    pendingApprovals.delete(token)
    pendingByChat.delete(chatId)
  }
}

export function hasPendingApproval(chatId: number) {
  return pendingByChat.has(chatId)
}

export function buildPlanPrompt(input: {
  history: Array<{ role: string; text: string }>
  userText: string
  attachments: ResolvedTelegramAttachment[]
}) {
  const lines = [
    "You are replying to a user through Telegram.",
    "This is a PLANNING-ONLY pass. Do NOT implement anything.",
    "Do NOT call ask_user or any interactive tools.",
    "",
    "Analyze the user's request and produce a concise plan:",
    "1. Goal: what the user wants",
    "2. Assumptions or open questions (list inline, do not prompt)",
    "3. Proposed steps",
    "4. Tools and files that will be modified",
    "5. Any risky or destructive actions",
    "",
    "Conversation so far:",
  ]

  for (const entry of input.history) {
    lines.push(`${entry.role === "user" ? "User" : "Assistant"}: ${entry.text}`)
  }

  const userTurnText = input.userText.trim() || "Please analyze the attached file(s) and respond to the user."
  lines.push("", `User: ${userTurnText}`)

  if (input.attachments.length > 0) {
    lines.push("", "Current message attachments:")
    for (const attachment of input.attachments) {
      lines.push(`- ${formatGeminiAttachmentReference(attachment.path)}`)
    }
  }

  lines.push("", "Assistant (planning only, no implementation):")
  return lines.join("\n")
}

export function buildExecutionPrompt(input: {
  userText: string
  planText: string
  attachments: ResolvedTelegramAttachment[]
}) {
  const lines = [
    "You are replying to a user through Telegram.",
    "The user has reviewed and APPROVED the following plan. Execute it now.",
    "",
    "Approved plan:",
    input.planText,
    "",
    "Original user request:",
    input.userText,
  ]

  if (input.attachments.length > 0) {
    lines.push("", "Attachments:")
    for (const attachment of input.attachments) {
      lines.push(`- ${formatGeminiAttachmentReference(attachment.path)}`)
    }
  }

  lines.push("", "After execution, provide a concise summary of what was done.")
  lines.push("", "Assistant:")
  return lines.join("\n")
}
