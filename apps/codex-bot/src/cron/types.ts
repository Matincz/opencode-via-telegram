export interface CodexCronJob {
  id: string
  title: string
  description: string
  schedule: string
  chatId: number
  enabled: boolean
  model?: string
  reasoningEffort?: string
  taskFile: string
  createdAt: string
  updatedAt: string
  lastRunAt?: string
  lastRunStatus?: "ok" | "error"
  lastRunSummary?: string
  lastRunLogFile?: string
}
