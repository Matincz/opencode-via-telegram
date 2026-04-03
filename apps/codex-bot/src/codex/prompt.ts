import type { ResolvedTelegramAttachment } from "../telegram/types"

function describeAttachment(attachment: ResolvedTelegramAttachment) {
  return `${attachment.filename} (${attachment.mime}) - ${attachment.path}`
}

export function buildCodexPrompt(input: {
  userText: string
  attachments: ResolvedTelegramAttachment[]
  mainMemory?: string
}) {
  const lines = [
    "You are replying to a user through Telegram.",
    "Be concise unless the user asks for detail.",
  ]

  if (input.mainMemory?.trim()) {
    lines.push("", "<main_memory>", input.mainMemory.trim(), "</main_memory>")
  }

  lines.push(
    "",
    "<current_request>",
    input.userText.trim() || "Please analyze the attached file(s) and respond to the user.",
  )

  if (input.attachments.length > 0) {
    lines.push("", "Current message attachments:")
    lines.push(...input.attachments.map((attachment) => `- ${describeAttachment(attachment)}`))
    lines.push("Use any relevant attachment content when answering.")
  }

  lines.push("</current_request>")
  return lines.join("\n")
}
