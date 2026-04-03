import * as fs from "fs"
import * as path from "path"
import { Cron } from "croner"
import type TelegramBot from "node-telegram-bot-api"
import { buildSessionErrorNotice } from "@matincz/telegram-bot-core/telegram/rendering"
import { logError, logInfo } from "../runtime/logger"
import { readMainMemory } from "../memory/store"
import { runCodexPrompt } from "../codex/client"
import { deliverCodexTextResult } from "../telegram/delivery"
import { cronJobMap, updateCronJob } from "./store"
import type { CodexCronJob } from "./types"

export interface CronManagerContext {
  bot: TelegramBot
  codexBin: string
  codexCwd?: string
  defaultModel?: string
  defaultReasoningEffort: string
  permissionMode: "bypassPermissions" | "workspace-write" | "danger-full-access" | "read-only"
}

function buildCronPrompt(job: CodexCronJob, taskBody: string) {
  const lines = [
    "You are executing a scheduled cron task from Telegram.",
    `Task ID: ${job.id}`,
    `Task Title: ${job.title}`,
  ]

  const mainMemory = readMainMemory().trim()
  if (mainMemory) {
    lines.push("", "<main_memory>", mainMemory, "</main_memory>")
  }

  lines.push(
    "",
    "Read the task description below and execute it.",
    "After completion, respond with a concise Telegram-friendly summary.",
    "",
    taskBody.trim(),
    "",
    "Assistant:",
  )

  return lines.join("\n")
}

export class CodexCronManager {
  private readonly scheduled = new Map<string, Cron>()
  private readonly running = new Set<string>()

  constructor(private readonly context: CronManagerContext) {}

  isRunning(jobId: string) {
    return this.running.has(jobId)
  }

  syncAll() {
    const knownIds = new Set(cronJobMap.keys())

    for (const [jobId, task] of this.scheduled.entries()) {
      if (!knownIds.has(jobId) || cronJobMap.get(jobId)?.enabled === false) {
        task.stop()
        this.scheduled.delete(jobId)
      }
    }

    for (const job of cronJobMap.values()) {
      if (!job.enabled) continue
      this.scheduleJob(job)
    }
  }

  private scheduleJob(job: CodexCronJob) {
    const existing = this.scheduled.get(job.id)
    if (existing) {
      existing.stop()
      this.scheduled.delete(job.id)
    }

    const task = new Cron(job.schedule, async () => {
      await this.runJob(job.id)
    })
    this.scheduled.set(job.id, task)
  }

  async runJob(jobId: string) {
    const job = cronJobMap.get(jobId)
    if (!job || !job.enabled) return
    if (this.running.has(jobId)) return

    this.running.add(jobId)
    try {
      const taskBody = fs.readFileSync(job.taskFile, "utf8")
      const startedAt = new Date().toISOString()
      logInfo("CRON.CODEX.RUN", { jobId: job.id, chatId: job.chatId, schedule: job.schedule })

      const response = await runCodexPrompt({
        prompt: buildCronPrompt(job, taskBody),
        model: job.model || this.context.defaultModel,
        reasoningEffort: job.reasoningEffort || this.context.defaultReasoningEffort,
        cwd: this.context.codexCwd,
        codexBin: this.context.codexBin,
        permissionMode: this.context.permissionMode,
      })

      const finishedAt = new Date().toISOString()
      const logFile = this.writeRunLog(job, [
        `startedAt: ${startedAt}`,
        `finishedAt: ${finishedAt}`,
        "status: ok",
        "",
        "# Response",
        "",
        response.text || "(empty)",
      ].join("\n"))

      updateCronJob(job.id, (current) => ({
        ...current,
        lastRunAt: finishedAt,
        lastRunStatus: "ok",
        lastRunSummary: response.text.slice(0, 500),
        lastRunLogFile: logFile,
      }))

      await deliverCodexTextResult({
        bot: this.context.bot,
        chatId: job.chatId,
        text: `⏰ Cron: ${job.title}\n\n${response.text || "任务已完成，但没有返回正文。"}`,
        prefix: `cron-${job.id}`,
        caption: `⏰ Cron ${job.title} 输出较长，已作为文件发送。`,
      })
    } catch (error) {
      logError("CRON.CODEX.RUN_FAILED", { jobId: job.id, chatId: job.chatId }, error)
      const finishedAt = new Date().toISOString()
      const logFile = this.writeRunLog(job, [
        `finishedAt: ${finishedAt}`,
        "status: error",
        "",
        "# Error",
        "",
        error instanceof Error ? error.stack || error.message : String(error),
      ].join("\n"))
      updateCronJob(job.id, (current) => ({
        ...current,
        lastRunAt: finishedAt,
        lastRunStatus: "error",
        lastRunSummary: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        lastRunLogFile: logFile,
      }))

      await this.context.bot.sendMessage(
        job.chatId,
        buildSessionErrorNotice({
          titleHtml: `⚠️ <b>Cron 任务失败</b>`,
          rawMessage: error instanceof Error ? error.message : String(error),
        }),
        {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        },
      ).catch(() => {})
    } finally {
      this.running.delete(jobId)
    }
  }

  private writeRunLog(job: CodexCronJob, content: string) {
    const runsDir = path.join(path.dirname(job.taskFile), "runs")
    fs.mkdirSync(runsDir, { recursive: true })
    const filePath = path.join(runsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.log`)
    fs.writeFileSync(filePath, content, "utf8")
    return filePath
  }
}
