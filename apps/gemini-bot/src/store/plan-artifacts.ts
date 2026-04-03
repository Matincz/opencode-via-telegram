import * as fs from "fs"
import * as path from "path"
import { readJsonFile, writeJsonFile } from "@matincz/telegram-bot-core/storage/json"
import { ensurePlanArtifactsDir, getPlanArtifactsDir } from "../gemini/runtime-paths"

export type PlanArtifactStatus = "pending_approval" | "approved" | "executing" | "completed" | "rejected" | "failed"
export type PlanTodoStatus = "pending" | "running" | "done" | "failed"

export interface PlanTodoItem {
  id: string
  text: string
  status: PlanTodoStatus
}

export interface PlanArtifact {
  id: string
  chatId: number
  createdAt: string
  updatedAt: string
  status: PlanArtifactStatus
  userText: string
  planText: string
  markdownPath: string
  toolSummary: string[]
  todos: PlanTodoItem[]
  planModel: string | null
  executionModel: string | null
  planSessionId: string | null
  executionSessionId: string | null
  resultSummary: string | null
  errorMessage: string | null
  approvalMessageId: number | null
}

const PLAN_ARTIFACTS_FILE = path.join(process.cwd(), "plan-artifacts.json")
const planArtifactMap = new Map<number, PlanArtifact[]>()

function createPlanArtifactId() {
  return `plan_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function createTodoId() {
  return `todo_${Math.random().toString(36).slice(2, 8)}`
}

function normalizeTodo(raw: unknown): PlanTodoItem | null {
  if (!raw || typeof raw !== "object") return null
  const value = raw as Record<string, unknown>
  if (typeof value.id !== "string" || !value.id.trim()) return null
  if (typeof value.text !== "string" || !value.text.trim()) return null
  if (value.status !== "pending" && value.status !== "running" && value.status !== "done" && value.status !== "failed") return null
  return {
    id: value.id.trim(),
    text: value.text.trim(),
    status: value.status,
  }
}

function normalizePlanArtifact(raw: unknown): PlanArtifact | null {
  if (!raw || typeof raw !== "object") return null
  const value = raw as Record<string, unknown>
  if (typeof value.id !== "string" || !value.id.trim()) return null
  if (typeof value.chatId !== "number" || !Number.isFinite(value.chatId)) return null
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return null
  if (
    value.status !== "pending_approval"
    && value.status !== "approved"
    && value.status !== "executing"
    && value.status !== "completed"
    && value.status !== "rejected"
    && value.status !== "failed"
  ) return null
  if (typeof value.userText !== "string" || typeof value.planText !== "string" || typeof value.markdownPath !== "string") return null
  if (!Array.isArray(value.toolSummary) || !Array.isArray(value.todos)) return null

  return {
    id: value.id.trim(),
    chatId: value.chatId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    status: value.status,
    userText: value.userText,
    planText: value.planText,
    markdownPath: value.markdownPath,
    toolSummary: value.toolSummary.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean),
    todos: value.todos.map((item) => normalizeTodo(item)).filter(Boolean) as PlanTodoItem[],
    planModel: typeof value.planModel === "string" && value.planModel.trim() ? value.planModel.trim() : null,
    executionModel: typeof value.executionModel === "string" && value.executionModel.trim() ? value.executionModel.trim() : null,
    planSessionId: typeof value.planSessionId === "string" && value.planSessionId.trim() ? value.planSessionId.trim() : null,
    executionSessionId: typeof value.executionSessionId === "string" && value.executionSessionId.trim() ? value.executionSessionId.trim() : null,
    resultSummary: typeof value.resultSummary === "string" && value.resultSummary.trim() ? value.resultSummary.trim() : null,
    errorMessage: typeof value.errorMessage === "string" && value.errorMessage.trim() ? value.errorMessage.trim() : null,
    approvalMessageId: typeof value.approvalMessageId === "number" && Number.isFinite(value.approvalMessageId) ? value.approvalMessageId : null,
  }
}

function persistArtifactsFile(rootDir = process.cwd()) {
  const filePath = path.join(rootDir, "plan-artifacts.json")
  const payload = Object.fromEntries(Array.from(planArtifactMap.entries()).map(([chatId, artifacts]) => [String(chatId), artifacts]))
  writeJsonFile(filePath, payload)
}

function buildPlanMarkdown(artifact: PlanArtifact) {
  const lines = [
    `# Plan ${artifact.id}`,
    "",
    `- Chat ID: ${artifact.chatId}`,
    `- Status: ${artifact.status}`,
    `- Created At: ${artifact.createdAt}`,
    `- Updated At: ${artifact.updatedAt}`,
    `- Plan Model: ${artifact.planModel || "Gemini CLI 默认"}`,
    `- Execution Model: ${artifact.executionModel || "Gemini CLI 默认"}`,
    `- Plan Session: ${artifact.planSessionId || "none"}`,
    `- Execution Session: ${artifact.executionSessionId || "none"}`,
    "",
    "## User Request",
    "",
    artifact.userText || "(empty)",
    "",
    "## Todo",
    "",
  ]

  if (artifact.todos.length === 0) {
    lines.push("- No todo items extracted")
  } else {
    for (const todo of artifact.todos) {
      const marker = todo.status === "done" ? "[x]" : todo.status === "failed" ? "[!]" : todo.status === "running" ? "[>]" : "[ ]"
      lines.push(`- ${marker} ${todo.text}`)
    }
  }

  lines.push("", "## Tools", "")
  if (artifact.toolSummary.length === 0) {
    lines.push("- None detected")
  } else {
    for (const tool of artifact.toolSummary) {
      lines.push(`- ${tool}`)
    }
  }

  lines.push("", "## Plan", "", artifact.planText)

  if (artifact.resultSummary) {
    lines.push("", "## Execution Summary", "", artifact.resultSummary)
  }

  if (artifact.errorMessage) {
    lines.push("", "## Error", "", artifact.errorMessage)
  }

  return lines.join("\n")
}

function writePlanMarkdown(artifact: PlanArtifact, rootDir = process.cwd()) {
  const artifactsDir = ensurePlanArtifactsDir(rootDir)
  const markdownPath = path.join(artifactsDir, `${artifact.id}.md`)
  fs.writeFileSync(markdownPath, buildPlanMarkdown({ ...artifact, markdownPath }), "utf8")
  artifact.markdownPath = markdownPath
}

function updateTodoStatuses(todos: PlanTodoItem[], status: PlanArtifactStatus) {
  if (todos.length === 0) return []
  if (status === "pending_approval" || status === "approved") {
    return todos.map((todo) => ({ ...todo, status: "pending" as const }))
  }
  if (status === "executing") {
    let runningAssigned = false
    return todos.map((todo) => {
      if (!runningAssigned) {
        runningAssigned = true
        return { ...todo, status: "running" as const }
      }
      return { ...todo, status: "pending" as const }
    })
  }
  if (status === "completed") {
    return todos.map((todo) => ({ ...todo, status: "done" as const }))
  }
  if (status === "failed") {
    let failedAssigned = false
    return todos.map((todo) => {
      if (!failedAssigned) {
        failedAssigned = true
        return { ...todo, status: "failed" as const }
      }
      return { ...todo, status: "pending" as const }
    })
  }
  return todos
}

function persistArtifact(artifact: PlanArtifact, rootDir = process.cwd()) {
  writePlanMarkdown(artifact, rootDir)
  persistArtifactsFile(rootDir)
}

export function extractPlanTodos(planText: string) {
  const candidates = planText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^#{1,6}\s/.test(line))
    .filter((line) => !/^(goal|assumptions|proposed steps|tools and files|risky actions)\s*:/i.test(line))

  const todoLines = candidates
    .filter((line) => /^(\d+\.)|^[-*]\s|^\[[ xX]\]\s/.test(line))
    .map((line) => line.replace(/^(\d+\.)\s*/, "").replace(/^[-*]\s*/, "").replace(/^\[[ xX]\]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 8)

  const normalized = (todoLines.length > 0 ? todoLines : candidates.slice(0, 5))
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line, index, items) => Boolean(line) && items.indexOf(line) === index)
    .slice(0, 8)

  return normalized.map((text) => ({
    id: createTodoId(),
    text,
    status: "pending" as const,
  }))
}

export function loadPlanArtifacts(rootDir = process.cwd()) {
  try {
    const parsed = readJsonFile(path.join(rootDir, "plan-artifacts.json"))
    if (!parsed || typeof parsed !== "object") return
    planArtifactMap.clear()
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue
      const artifacts = value.map((item) => normalizePlanArtifact(item)).filter(Boolean) as PlanArtifact[]
      planArtifactMap.set(Number(key), artifacts)
    }
  } catch (error) {
    console.error("加载计划产物失败:", error)
  }
}

export function listPlanArtifacts(chatId: number) {
  return planArtifactMap.get(chatId) || []
}

export function getPlanArtifactById(chatId: number, artifactId: string) {
  return listPlanArtifacts(chatId).find((artifact) => artifact.id === artifactId) || null
}

export function getLatestPlanArtifact(chatId: number) {
  return listPlanArtifacts(chatId).at(-1) || null
}

export function createPlanArtifact(input: {
  chatId: number
  userText: string
  planText: string
  toolSummary: string[]
  planModel: string | null
  executionModel: string | null
  planSessionId?: string
  rootDir?: string
}) {
  const rootDir = input.rootDir || process.cwd()
  const now = new Date().toISOString()
  const artifact: PlanArtifact = {
    id: createPlanArtifactId(),
    chatId: input.chatId,
    createdAt: now,
    updatedAt: now,
    status: "pending_approval",
    userText: input.userText,
    planText: input.planText,
    markdownPath: path.join(getPlanArtifactsDir(rootDir), "pending.md"),
    toolSummary: input.toolSummary.slice(),
    todos: extractPlanTodos(input.planText),
    planModel: input.planModel,
    executionModel: input.executionModel,
    planSessionId: input.planSessionId || null,
    executionSessionId: null,
    resultSummary: null,
    errorMessage: null,
    approvalMessageId: null,
  }

  const existing = listPlanArtifacts(input.chatId)
  planArtifactMap.set(input.chatId, [...existing, artifact].slice(-20))
  persistArtifact(artifact, rootDir)
  return artifact
}

export function updatePlanArtifact(
  chatId: number,
  artifactId: string,
  patch: Partial<Omit<PlanArtifact, "id" | "chatId" | "createdAt" | "markdownPath">> & { status?: PlanArtifactStatus },
  rootDir = process.cwd(),
) {
  const artifacts = listPlanArtifacts(chatId)
  const index = artifacts.findIndex((artifact) => artifact.id === artifactId)
  if (index < 0) return null

  const current = artifacts[index]!
  const nextStatus = patch.status || current.status
  const nextValue: PlanArtifact = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
    status: nextStatus,
    todos: patch.todos ? patch.todos.slice() : updateTodoStatuses(current.todos, nextStatus),
  }

  const nextArtifacts = artifacts.slice()
  nextArtifacts[index] = nextValue
  planArtifactMap.set(chatId, nextArtifacts)
  persistArtifact(nextValue, rootDir)
  return nextValue
}

export function setPlanArtifactApprovalMessageId(chatId: number, artifactId: string, messageId: number, rootDir = process.cwd()) {
  return updatePlanArtifact(chatId, artifactId, { approvalMessageId: messageId }, rootDir)
}

export { PLAN_ARTIFACTS_FILE }
