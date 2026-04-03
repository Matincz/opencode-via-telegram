import * as fs from "fs"
import * as path from "path"
import type TelegramBot from "node-telegram-bot-api"
import { sendRenderedAssistantPart } from "@matincz/telegram-bot-core/telegram/rendering"

export const OUTPUT_TO_USER_DIR = path.join(process.cwd(), "output_to_user")
const TELEGRAM_TEXT_LIMIT = 3500

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_TO_USER_DIR, { recursive: true })
}

function detectExtension(content: string) {
  const trimmed = content.trimStart()
  if (trimmed.startsWith("diff --git") || /^--- .+\n\+\+\+ /m.test(content)) return "diff"
  if (/^\s*[{[]/.test(trimmed)) return "json"
  if (/^\s*<[^>]+>/.test(trimmed)) return "html"
  return "md"
}

function createArtifactFile(prefix: string, content: string) {
  ensureOutputDir()
  const safePrefix = prefix.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "claude-output"
  const extension = detectExtension(content)
  const filename = `${safePrefix}-${Date.now()}.${extension}`
  const absolutePath = path.join(OUTPUT_TO_USER_DIR, filename)
  fs.writeFileSync(absolutePath, content, "utf8")
  return absolutePath
}

export async function deliverClaudeTextResult(input: {
  bot: TelegramBot
  chatId: number
  text: string
  prefix: string
  caption?: string
}) {
  const text = input.text.trim() || "Claude 已完成，但没有返回可显示的正文。"
  if (text.length <= TELEGRAM_TEXT_LIMIT) {
    await sendRenderedAssistantPart(input.bot as any, input.chatId, "text", text)
    return { mode: "message" as const }
  }

  const artifactPath = createArtifactFile(input.prefix, text)
  const caption = input.caption || "📄 输出较长，已作为文件发送。"

  await input.bot.sendMessage(input.chatId, caption).catch(() => {})
  await input.bot.sendDocument(input.chatId, artifactPath, {
    caption: path.basename(artifactPath),
  } as any).catch(() => {})

  return {
    mode: "file" as const,
    artifactPath,
  }
}
