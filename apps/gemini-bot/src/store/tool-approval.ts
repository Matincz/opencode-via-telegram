import * as path from "path"
import { readJsonFile, writeJsonFile } from "@matincz/telegram-bot-core/storage/json"

export type ToolApprovalPreference = "always"

const TOOL_APPROVAL_PREFERENCES_FILE = path.join(process.cwd(), "tool-approval-preferences.json")

const toolApprovalPreferenceMap = new Map<number, ToolApprovalPreference>()

export function loadToolApprovalPreferences(rootDir = process.cwd()) {
  const filePath = path.join(rootDir, "tool-approval-preferences.json")
  try {
    const parsed = readJsonFile(filePath)
    if (!parsed || typeof parsed !== "object") return
    toolApprovalPreferenceMap.clear()
    for (const [key, value] of Object.entries(parsed)) {
      if (value === "always") {
        toolApprovalPreferenceMap.set(Number(key), value)
      }
    }
    console.log(`✅ 已从本地加载了 ${toolApprovalPreferenceMap.size} 个工具审批偏好。`)
  } catch (error) {
    console.error("加载工具审批偏好失败:", error)
  }
}

export function saveToolApprovalPreferences(rootDir = process.cwd()) {
  const filePath = path.join(rootDir, "tool-approval-preferences.json")
  try {
    const value = Object.fromEntries(Array.from(toolApprovalPreferenceMap.entries()).map(([chatId, preference]) => [String(chatId), preference]))
    writeJsonFile(filePath, value)
  } catch (error) {
    console.error("保存工具审批偏好失败:", error)
  }
}

export function getToolApprovalPreference(chatId: number) {
  return toolApprovalPreferenceMap.get(chatId)
}

export function setToolApprovalPreference(chatId: number, preference: ToolApprovalPreference) {
  toolApprovalPreferenceMap.set(chatId, preference)
  saveToolApprovalPreferences()
}

export function setToolApprovalPreferenceForRoot(chatId: number, preference: ToolApprovalPreference, rootDir = process.cwd()) {
  toolApprovalPreferenceMap.set(chatId, preference)
  saveToolApprovalPreferences(rootDir)
}

export function clearToolApprovalPreference(chatId: number, rootDir = process.cwd()) {
  if (!toolApprovalPreferenceMap.delete(chatId)) return false
  saveToolApprovalPreferences(rootDir)
  return true
}

export function shouldAlwaysApproveTools(chatId: number) {
  return toolApprovalPreferenceMap.get(chatId) === "always"
}

export function resetToolApprovalPreferences() {
  toolApprovalPreferenceMap.clear()
}

export { TOOL_APPROVAL_PREFERENCES_FILE }
