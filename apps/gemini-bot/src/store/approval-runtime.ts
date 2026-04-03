import * as path from "path"
import { readJsonFile, writeJsonFile } from "@matincz/telegram-bot-core/storage/json"
import type { ToolApprovalStrategy } from "../gemini/approval"

export type GeminiExecutionMode = "default" | "yolo"

export interface ApprovalRuntimeConfig {
  strategy?: ToolApprovalStrategy
  executionMode?: GeminiExecutionMode
  sandbox?: boolean
}

const APPROVAL_RUNTIME_FILE = path.join(process.cwd(), "approval-runtime.json")

const runtimeConfigMap = new Map<number, ApprovalRuntimeConfig>()

function normalizeRuntimeConfig(raw: unknown): ApprovalRuntimeConfig | null {
  if (!raw || typeof raw !== "object") return null
  const value = raw as Record<string, unknown>
  const nextValue: ApprovalRuntimeConfig = {}

  if (value.strategy === "notify" || value.strategy === "plan_then_execute") {
    nextValue.strategy = value.strategy
  }

  if (value.executionMode === "default" || value.executionMode === "yolo") {
    nextValue.executionMode = value.executionMode
  }

  if (typeof value.sandbox === "boolean") {
    nextValue.sandbox = value.sandbox
  }

  return Object.keys(nextValue).length > 0 ? nextValue : null
}

function saveRuntimeConfig(rootDir = process.cwd()) {
  const filePath = path.join(rootDir, "approval-runtime.json")
  const payload = Object.fromEntries(Array.from(runtimeConfigMap.entries()).map(([chatId, value]) => [String(chatId), value]))
  writeJsonFile(filePath, payload)
}

export function loadApprovalRuntimeConfig(rootDir = process.cwd()) {
  try {
    const parsed = readJsonFile(path.join(rootDir, "approval-runtime.json"))
    if (!parsed || typeof parsed !== "object") return
    runtimeConfigMap.clear()

    for (const [key, value] of Object.entries(parsed)) {
      const normalized = normalizeRuntimeConfig(value)
      if (normalized) {
        runtimeConfigMap.set(Number(key), normalized)
      }
    }
  } catch (error) {
    console.error("加载审批运行态配置失败:", error)
  }
}

export function getApprovalRuntimeConfig(chatId: number) {
  return runtimeConfigMap.get(chatId)
}

export function setApprovalRuntimeConfig(chatId: number, patch: Partial<ApprovalRuntimeConfig>, rootDir = process.cwd()) {
  const current = runtimeConfigMap.get(chatId) || {}
  const nextValue: ApprovalRuntimeConfig = {
    ...current,
    ...patch,
  }

  if (!nextValue.strategy && !nextValue.executionMode && typeof nextValue.sandbox !== "boolean") {
    runtimeConfigMap.delete(chatId)
  } else {
    runtimeConfigMap.set(chatId, nextValue)
  }

  saveRuntimeConfig(rootDir)
  return runtimeConfigMap.get(chatId) || null
}

export function clearApprovalRuntimeConfig(chatId: number, rootDir = process.cwd()) {
  const changed = runtimeConfigMap.delete(chatId)
  if (changed) {
    saveRuntimeConfig(rootDir)
  }
  return changed
}

export function resolveApprovalRuntimeConfig(
  chatId: number,
  defaults: { strategy: ToolApprovalStrategy; executionMode: GeminiExecutionMode; sandbox: boolean },
) {
  const override = runtimeConfigMap.get(chatId)
  return {
    strategy: override?.strategy || defaults.strategy,
    executionMode: override?.executionMode || defaults.executionMode,
    sandbox: typeof override?.sandbox === "boolean" ? override.sandbox : defaults.sandbox,
  }
}

export { APPROVAL_RUNTIME_FILE }
