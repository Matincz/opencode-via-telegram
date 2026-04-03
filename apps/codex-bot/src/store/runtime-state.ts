import * as path from "path"
import { readJsonFile } from "@matincz/telegram-bot-core/storage/json"
import { createDebouncedJsonWriter } from "@matincz/telegram-bot-core/storage/debounced-writer"
import type { CodexPermissionMode } from "../codex/client"
import { normalizeWorkspacePath } from "./workspace-path"

const SESSIONS_FILE = path.join(process.cwd(), "sessions-map.json")
const SELECTED_MODELS_FILE = path.join(process.cwd(), "selected-models.json")
const SELECTED_REASONING_EFFORTS_FILE = path.join(process.cwd(), "selected-reasoning-efforts.json")
const EXECUTION_APPROVAL_MODES_FILE = path.join(process.cwd(), "execution-approval-modes.json")
const CHAT_WORKING_DIRECTORIES_FILE = path.join(process.cwd(), "chat-working-directories.json")
const CHAT_PERMISSION_MODES_FILE = path.join(process.cwd(), "chat-permission-modes.json")
const CHAT_WORKSPACE_HISTORY_FILE = path.join(process.cwd(), "chat-workspace-history.json")

const sessionsWriter = createDebouncedJsonWriter(SESSIONS_FILE)
const modelsWriter = createDebouncedJsonWriter(SELECTED_MODELS_FILE)
const reasoningEffortsWriter = createDebouncedJsonWriter(SELECTED_REASONING_EFFORTS_FILE)
const executionApprovalModesWriter = createDebouncedJsonWriter(EXECUTION_APPROVAL_MODES_FILE)
const chatWorkingDirectoriesWriter = createDebouncedJsonWriter(CHAT_WORKING_DIRECTORIES_FILE)
const chatPermissionModesWriter = createDebouncedJsonWriter(CHAT_PERMISSION_MODES_FILE)
const chatWorkspaceHistoryWriter = createDebouncedJsonWriter(CHAT_WORKSPACE_HISTORY_FILE)

export const sessionMap = new Map<number, string>()
export const selectedModelMap = new Map<number, string>()
export const selectedReasoningEffortMap = new Map<number, string>()
export const executionApprovalModeMap = new Map<number, string>()
export const chatWorkingDirectoryMap = new Map<number, string>()
export const chatPermissionModeMap = new Map<number, CodexPermissionMode>()
export const chatWorkspaceHistoryMap = new Map<number, string[]>()

export function setChatSession(chatId: number, sessionId: string) {
  sessionMap.set(chatId, sessionId)
}

export function clearChatSession(chatId: number) {
  const changed = sessionMap.delete(chatId)
  saveSessions()
  return changed
}

export function loadSessions() {
  try {
    const parsed = readJsonFile(SESSIONS_FILE)
    if (!parsed) return
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) {
        sessionMap.set(Number(key), value)
      }
    }
    console.log(`📂 已从本地加载了 ${sessionMap.size} 个 Codex 会话记录。`)
  } catch (error) {
    console.error("加载 Codex 会话记录失败:", error)
  }
}

export function saveSessions() {
  try {
    const value = Object.fromEntries(Array.from(sessionMap.entries()).map(([key, sessionId]) => [String(key), sessionId]))
    sessionsWriter.schedule(value)
  } catch (error) {
    console.error("保存 Codex 会话记录失败:", error)
  }
}

export function loadSelectedModels() {
  try {
    const parsed = readJsonFile(SELECTED_MODELS_FILE)
    if (!parsed) return
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) {
        selectedModelMap.set(Number(key), value.trim())
      }
    }
    console.log(`🤖 已从本地加载了 ${selectedModelMap.size} 个 Codex 模型选择记录。`)
  } catch (error) {
    console.error("加载 Codex 模型选择记录失败:", error)
  }
}

export function saveSelectedModels() {
  try {
    const value = Object.fromEntries(Array.from(selectedModelMap.entries()).map(([key, model]) => [String(key), model]))
    modelsWriter.schedule(value)
  } catch (error) {
    console.error("保存 Codex 模型选择记录失败:", error)
  }
}

export function loadSelectedReasoningEfforts() {
  try {
    const parsed = readJsonFile(SELECTED_REASONING_EFFORTS_FILE)
    if (!parsed) return
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) {
        selectedReasoningEffortMap.set(Number(key), value.trim())
      }
    }
    console.log(`🧠 已从本地加载了 ${selectedReasoningEffortMap.size} 个 Codex reasoning effort 记录。`)
  } catch (error) {
    console.error("加载 Codex reasoning effort 记录失败:", error)
  }
}

export function saveSelectedReasoningEfforts() {
  try {
    const value = Object.fromEntries(Array.from(selectedReasoningEffortMap.entries()).map(([key, effort]) => [String(key), effort]))
    reasoningEffortsWriter.schedule(value)
  } catch (error) {
    console.error("保存 Codex reasoning effort 记录失败:", error)
  }
}

export function loadExecutionApprovalModes() {
  try {
    const parsed = readJsonFile(EXECUTION_APPROVAL_MODES_FILE)
    if (!parsed) return
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) {
        executionApprovalModeMap.set(Number(key), value.trim())
      }
    }
    console.log(`🛂 已从本地加载了 ${executionApprovalModeMap.size} 个 Codex 审批模式记录。`)
  } catch (error) {
    console.error("加载 Codex 审批模式记录失败:", error)
  }
}

export function saveExecutionApprovalModes() {
  try {
    const value = Object.fromEntries(Array.from(executionApprovalModeMap.entries()).map(([key, mode]) => [String(key), mode]))
    executionApprovalModesWriter.schedule(value)
  } catch (error) {
    console.error("保存 Codex 审批模式记录失败:", error)
  }
}

export function loadChatWorkingDirectories() {
  try {
    const parsed = readJsonFile(CHAT_WORKING_DIRECTORIES_FILE)
    if (!parsed) return
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) {
        const normalized = normalizeWorkspacePath(value)
        if (normalized) {
          chatWorkingDirectoryMap.set(Number(key), normalized)
        }
      }
    }
    console.log(`📁 已从本地加载了 ${chatWorkingDirectoryMap.size} 个聊天工作目录记录。`)
  } catch (error) {
    console.error("加载聊天工作目录记录失败:", error)
  }
}

export function saveChatWorkingDirectories() {
  try {
    const value = Object.fromEntries(Array.from(chatWorkingDirectoryMap.entries()).map(([key, cwd]) => [String(key), cwd]))
    chatWorkingDirectoriesWriter.schedule(value)
  } catch (error) {
    console.error("保存聊天工作目录记录失败:", error)
  }
}

export function loadChatPermissionModes() {
  try {
    const parsed = readJsonFile(CHAT_PERMISSION_MODES_FILE)
    if (!parsed) return
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) {
        chatPermissionModeMap.set(Number(key), value.trim() as CodexPermissionMode)
      }
    }
    console.log(`🔐 已从本地加载了 ${chatPermissionModeMap.size} 个聊天权限模式记录。`)
  } catch (error) {
    console.error("加载聊天权限模式记录失败:", error)
  }
}

export function saveChatPermissionModes() {
  try {
    const value = Object.fromEntries(Array.from(chatPermissionModeMap.entries()).map(([key, mode]) => [String(key), mode]))
    chatPermissionModesWriter.schedule(value)
  } catch (error) {
    console.error("保存聊天权限模式记录失败:", error)
  }
}

export function loadChatWorkspaceHistory() {
  try {
    const parsed = readJsonFile(CHAT_WORKSPACE_HISTORY_FILE)
    if (!parsed) return
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        const history = value
          .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
          .map((entry) => normalizeWorkspacePath(entry))
          .filter((entry): entry is string => Boolean(entry))
        chatWorkspaceHistoryMap.set(Number(key), history.slice(0, 20))
      }
    }
    console.log(`🗂 已从本地加载了 ${chatWorkspaceHistoryMap.size} 个聊天 workspace 历史记录。`)
  } catch (error) {
    console.error("加载聊天 workspace 历史记录失败:", error)
  }
}

export function saveChatWorkspaceHistory() {
  try {
    const value = Object.fromEntries(Array.from(chatWorkspaceHistoryMap.entries()).map(([key, history]) => [String(key), history]))
    chatWorkspaceHistoryWriter.schedule(value)
  } catch (error) {
    console.error("保存聊天 workspace 历史记录失败:", error)
  }
}

export function rememberChatWorkspace(chatId: number, cwd: string) {
  const history = chatWorkspaceHistoryMap.get(chatId) || []
  const normalized = normalizeWorkspacePath(cwd)
  if (!normalized) return history
  const next = [normalized, ...history.filter((entry) => entry !== normalized)].slice(0, 20)
  chatWorkspaceHistoryMap.set(chatId, next)
  saveChatWorkspaceHistory()
  return next
}

export function clearChatWorkspaceHistory(chatId: number) {
  const changed = chatWorkspaceHistoryMap.delete(chatId)
  if (changed) saveChatWorkspaceHistory()
  return changed
}

export function flushAllPersistence() {
  sessionsWriter.flush()
  modelsWriter.flush()
  reasoningEffortsWriter.flush()
  executionApprovalModesWriter.flush()
  chatWorkingDirectoriesWriter.flush()
  chatPermissionModesWriter.flush()
  chatWorkspaceHistoryWriter.flush()
}
