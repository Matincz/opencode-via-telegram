import * as fs from "fs"
import * as path from "path"
import { createDebouncedJsonWriter } from "@matincz/telegram-bot-core/storage/debounced-writer"
import { readJsonFile } from "@matincz/telegram-bot-core/storage/json"
import type { CodexCronJob } from "./types"

const CRON_JOBS_FILE = path.join(process.cwd(), "cron-jobs.json")
export const CRON_TASKS_DIR = path.join(process.cwd(), "cron-tasks")

const jobsWriter = createDebouncedJsonWriter(CRON_JOBS_FILE)

export const cronJobMap = new Map<string, CodexCronJob>()

function sanitizeJobId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function loadCronJobs() {
  try {
    const parsed = readJsonFile(CRON_JOBS_FILE)
    const jobs = Array.isArray((parsed as any)?.jobs) ? (parsed as any).jobs : []
    cronJobMap.clear()
    for (const raw of jobs) {
      if (!raw || typeof raw.id !== "string") continue
      cronJobMap.set(raw.id, raw as CodexCronJob)
    }
    fs.mkdirSync(CRON_TASKS_DIR, { recursive: true })
    console.log(`⏰ 已从本地加载了 ${cronJobMap.size} 个 Codex cron 任务。`)
  } catch (error) {
    console.error("加载 Codex cron 任务失败:", error)
  }
}

export function saveCronJobs() {
  try {
    jobsWriter.schedule({
      jobs: Array.from(cronJobMap.values()).sort((a, b) => a.id.localeCompare(b.id)),
    })
  } catch (error) {
    console.error("保存 Codex cron 任务失败:", error)
  }
}

export function flushCronJobs() {
  jobsWriter.flush()
}

export function createCronTaskFile(input: {
  id: string
  title: string
  description: string
}) {
  const taskDir = path.join(CRON_TASKS_DIR, input.id)
  fs.mkdirSync(taskDir, { recursive: true })
  const taskFile = path.join(taskDir, "TASK_DESCRIPTION.md")
  if (!fs.existsSync(taskFile)) {
    fs.writeFileSync(
      taskFile,
      `# ${input.title}\n\n## Goal\n\n${input.description}\n\n## Assignment\n\n(Write the concrete steps this scheduled Codex task should perform.)\n\n## Output\n\n(Write what the Telegram result should contain.)\n`,
      "utf8",
    )
  }
  return taskFile
}

export function getCronTaskDir(jobId: string) {
  return path.join(CRON_TASKS_DIR, jobId)
}

export function getCronRunsDir(jobId: string) {
  return path.join(getCronTaskDir(jobId), "runs")
}

export function readCronTaskFile(taskFile: string) {
  return fs.readFileSync(taskFile, "utf8")
}

export function writeCronTaskFile(taskFile: string, content: string) {
  fs.writeFileSync(taskFile, content, "utf8")
}

export function addCronJob(input: {
  id: string
  title: string
  description: string
  schedule: string
  chatId: number
  model?: string
  reasoningEffort?: string
}) {
  const id = sanitizeJobId(input.id)
  if (!id) {
    throw new Error("Cron job id 不能为空。")
  }
  if (cronJobMap.has(id)) {
    throw new Error(`Cron job 已存在：${id}`)
  }
  const now = new Date().toISOString()
  const job: CodexCronJob = {
    id,
    title: input.title.trim(),
    description: input.description.trim(),
    schedule: input.schedule.trim(),
    chatId: input.chatId,
    enabled: true,
    model: input.model?.trim() || undefined,
    reasoningEffort: input.reasoningEffort?.trim() || undefined,
    taskFile: createCronTaskFile({
      id,
      title: input.title,
      description: input.description,
    }),
    createdAt: now,
    updatedAt: now,
  }
  cronJobMap.set(id, job)
  saveCronJobs()
  return job
}

export function updateCronJob(id: string, updater: (job: CodexCronJob) => CodexCronJob) {
  const existing = cronJobMap.get(id)
  if (!existing) return null
  const updated = updater(existing)
  cronJobMap.set(id, {
    ...updated,
    updatedAt: new Date().toISOString(),
  })
  saveCronJobs()
  return cronJobMap.get(id) ?? null
}

export function removeCronJob(id: string) {
  const existing = cronJobMap.get(id)
  if (!existing) return null
  cronJobMap.delete(id)
  try {
    fs.rmSync(path.dirname(existing.taskFile), { recursive: true, force: true })
  } catch (error) {
    console.error("删除 Codex cron 任务目录失败:", error)
  }
  saveCronJobs()
  return existing
}
