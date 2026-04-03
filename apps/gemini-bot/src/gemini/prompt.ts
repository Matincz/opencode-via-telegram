import type { ChatHistoryEntry } from "../store/runtime-state"
import type { ResolvedTelegramAttachment } from "../telegram/types"
import { formatGeminiAttachmentReference } from "./attachment-paths"

function buildAttachmentPromptLines(attachments: ResolvedTelegramAttachment[]) {
  if (attachments.length === 0) return []

  return [
    "Current message attachments:",
    ...attachments.map((attachment) => `- ${formatGeminiAttachmentReference(attachment.path)}`),
    "Use the attachment content when it is relevant to the answer.",
  ]
}

export function formatUserHistoryEntry(userText: string, attachments: ResolvedTelegramAttachment[]) {
  const trimmed = userText.trim()
  const lines: string[] = []

  if (trimmed) {
    lines.push(trimmed)
  } else if (attachments.length > 0) {
    lines.push("Please analyze the attached file(s) and respond to the user.")
  }

  if (attachments.length > 0) {
    lines.push(`[Attachments: ${attachments.map((attachment) => attachment.filename).join(", ")}]`)
  }

  return lines.join("\n")
}

export function buildPromptFromHistory(input: {
  history: ChatHistoryEntry[]
  userText: string
  attachments: ResolvedTelegramAttachment[]
}) {
  const lines = [
    "You are replying to a user through Telegram.",
    "Be concise unless the user asks for detail.",
  ]

  if (input.history.length > 0) {
    lines.push("", "<conversation_history>")
    for (const entry of input.history) {
      const tag = entry.role === "user" ? "user" : "assistant"
      lines.push(`<${tag}>${entry.text}</${tag}>`)
    }
    lines.push("</conversation_history>")
  }

  lines.push("", "<current_request>")

  const userTurnText = input.userText.trim() || "Please analyze the attached file(s) and respond to the user."
  lines.push(userTurnText)

  const attachmentLines = buildAttachmentPromptLines(input.attachments)
  if (attachmentLines.length > 0) {
    lines.push("", ...attachmentLines)
  }

  lines.push("</current_request>")
  return lines.join("\n")
}
