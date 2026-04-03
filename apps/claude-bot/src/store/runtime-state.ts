import * as path from "path"
import { createDebouncedJsonWriter } from "@matincz/telegram-bot-core/storage/debounced-writer"
import { readJsonFile } from "@matincz/telegram-bot-core/storage/json"
import type { ClaudePermissionMode } from "../claude/client"
import { normalizeWorkspacePath } from "./workspace-path"

const SESSIONS_FILE = path.join(process.cwd(), "sessions-map.json")
const SELECTED_MODELS_FILE = path.join(process.cwd(), "selected-models.json")
const SELECTED_EFFORTS_FILE = path.join(process.cwd(), "selected-efforts.json")
const CHAT_WORKING_DIRECTORIES_FILE = path.join(process.cwd(), "chat-working-directories.json")
const CHAT_PERMISSION_MODES_FILE = path.join(process.cwd(), "chat-permission-modes.json")
const CHAT_WORKSPACE_HISTORY_FILE = path.join(process.cwd(), "chat-workspace-history.json")
const SESSION_HISTORY_FILE = path.join(process.cwd(), "session-history.json")

const sessionsWriter = createDebouncedJsonWriter(SESSIONS_FILE)
const modelsWriter = createDebouncedJsonWriter(SELECTED_MODELS_FILE)
const effortsWriter = createDebouncedJsonWriter(SELECTED_EFFORTS_FILE)
const chatWorkingDirectoriesWriter = createDebouncedJsonWriter(CHAT_WORKING_DIRECTORIES_FILE)
const chatPermissionModesWriter = createDebouncedJsonWriter(CHAT_PERMISSION_MODES_FILE)
const chatWorkspaceHistoryWriter = createDebouncedJsonWriter(CHAT_WORKSPACE_HISTORY_FILE)
const sessionHistoryWriter = createDebouncedJsonWriter(SESSION_HISTORY_FILE)

export interface ClaudeSessionRecord {
  id: string
  label: string
  createdAt: string
  updatedAt: string
  lastUsedAt: string
  workspace?: string
}

export const sessionMap = new Map<number, string>()
export const selectedModelMap = new Map<number, string>()
export const selectedEffortMap = new Map<number, string>()
export const chatWorkingDirectoryMap = new Map<number, string>()
export const chatPermissionModeMap = new Map<number, ClaudePermissionMode>()
export const chatWorkspaceHistoryMap = new Map<number, string[]>()
export const sessionHistoryMap = new Map<number, ClaudeSessionRecord[]>()

function defaultSessionLabel(sessionId: string) {
  return `session-${sessionId.slice(0, 8)}`
}

function normalizeRecords(records: ClaudeSessionRecord[]) {
  return [...records].sort((a, b) => {
    if (a.lastUsedAt === b.lastUsedAt) {
      return a.createdAt.localeCompare(b.createdAt)
    }
    return b.lastUsedAt.localeCompare(a.lastUsedAt)
  })
}

function saveMap(writer: { schedule: (value: unknown) => void }, map: Map<number, string>) {
  writer.schedule(Object.fromEntries(Array.from(map.entries()).map(([key, value]) => [String(key), value])))
}

function loadStringMap(filePath: string, target: Map<number, string>, label: string) {
  try {
    const parsed = readJsonFile(filePath)
    if (!parsed) return
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) {
        target.set(Number(key), value.trim())
      }
    }
    console.log(`${label} ${target.size} 条。`)
  } catch (error) {
    console.error(`加载 ${filePath} 失败:`, error)
  }
}

export function setChatSession(chatId: number, sessionId: string) {
  sessionMap.set(chatId, sessionId)
}

export function clearChatSession(chatId: number) {
  const changed = sessionMap.delete(chatId)
  saveSessions()
  return changed
}

export function loadSessions() {
  loadStringMap(SESSIONS_FILE, sessionMap, "📂 已加载 Claude 会话记录")
}

export function saveSessions() {
  try {
    saveMap(sessionsWriter, sessionMap)
  } catch (error) {
    console.error("保存 Claude 会话记录失败:", error)
  }
}

export function loadSelectedModels() {
  loadStringMap(SELECTED_MODELS_FILE, selectedModelMap, "🤖 已加载 Claude 模型选择记录")
}

export function saveSelectedModels() {
  try {
    saveMap(modelsWriter, selectedModelMap)
  } catch (error) {
    console.error("保存 Claude 模型选择记录失败:", error)
  }
}

export function loadSelectedEfforts() {
  loadStringMap(SELECTED_EFFORTS_FILE, selectedEffortMap, "🧠 已加载 Claude effort 记录")
}

export function saveSelectedEfforts() {
  try {
    saveMap(effortsWriter, selectedEffortMap)
  } catch (error) {
    console.error("保存 Claude effort 记录失败:", error)
  }
}

export function loadChatWorkingDirectories() {
  try {
    const parsed = readJsonFile(CHAT_WORKING_DIRECTORIES_FILE)
    if (!parsed) return
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) {
        const normalized = normalizeWorkspacePath(value)
        if (normalized) {
          chatWorkingDirectoryMap.set(Number(key), normalized)
        }
      }
    }
    console.log(`📁 已加载聊天工作目录 ${chatWorkingDirectoryMap.size} 条。`)
  } catch (error) {
    console.error("加载聊天工作目录失败:", error)
  }
}

export function saveChatWorkingDirectories() {
  try {
    saveMap(chatWorkingDirectoriesWriter, chatWorkingDirectoryMap)
  } catch (error) {
    console.error("保存聊天工作目录失败:", error)
  }
}

export function loadChatPermissionModes() {
  try {
    const parsed = readJsonFile(CHAT_PERMISSION_MODES_FILE)
    if (!parsed) return
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) {
        chatPermissionModeMap.set(Number(key), value.trim() as ClaudePermissionMode)
      }
    }
    console.log(`🔐 已加载聊天权限模式 ${chatPermissionModeMap.size} 条。`)
  } catch (error) {
    console.error("加载聊天权限模式失败:", error)
  }
}

export function saveChatPermissionModes() {
  try {
    chatPermissionModesWriter.schedule(
      Object.fromEntries(Array.from(chatPermissionModeMap.entries()).map(([key, value]) => [String(key), value])),
    )
  } catch (error) {
    console.error("保存聊天权限模式失败:", error)
  }
}

export function loadChatWorkspaceHistory() {
  try {
    const parsed = readJsonFile(CHAT_WORKSPACE_HISTORY_FILE)
    if (!parsed) return
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue
      const history = value
        .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
        .map((entry) => normalizeWorkspacePath(entry))
        .filter((entry): entry is string => Boolean(entry))
      chatWorkspaceHistoryMap.set(Number(key), history.slice(0, 20))
    }
    console.log(`🗂 已加载 workspace 历史 ${chatWorkspaceHistoryMap.size} 条。`)
  } catch (error) {
    console.error("加载 workspace 历史失败:", error)
  }
}

export function saveChatWorkspaceHistory() {
  try {
    chatWorkspaceHistoryWriter.schedule(
      Object.fromEntries(Array.from(chatWorkspaceHistoryMap.entries()).map(([key, value]) => [String(key), value])),
    )
  } catch (error) {
    console.error("保存 workspace 历史失败:", error)
  }
}

export function rememberChatWorkspace(chatId: number, cwd: string) {
  const normalized = normalizeWorkspacePath(cwd)
  if (!normalized) return chatWorkspaceHistoryMap.get(chatId) || []
  const history = chatWorkspaceHistoryMap.get(chatId) || []
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

export function loadSessionHistory() {
  try {
    const parsed = readJsonFile(SESSION_HISTORY_FILE)
    if (!parsed || typeof parsed !== "object") return

    for (const [chatId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue
      const records = value
        .filter((record): record is ClaudeSessionRecord => {
          return Boolean(
            record
            && typeof record === "object"
            && typeof (record as ClaudeSessionRecord).id === "string"
            && typeof (record as ClaudeSessionRecord).label === "string",
          )
        })
        .map((record) => ({
          id: record.id,
          label: record.label.trim() || defaultSessionLabel(record.id),
          createdAt: record.createdAt || new Date().toISOString(),
          updatedAt: record.updatedAt || record.createdAt || new Date().toISOString(),
          lastUsedAt: record.lastUsedAt || record.updatedAt || record.createdAt || new Date().toISOString(),
          workspace: normalizeWorkspacePath(record.workspace),
        }))
      sessionHistoryMap.set(Number(chatId), normalizeRecords(records))
    }

    console.log(`🧵 已加载会话历史 ${sessionHistoryMap.size} 组。`)
  } catch (error) {
    console.error("加载会话历史失败:", error)
  }
}

export function saveSessionHistory() {
  try {
    sessionHistoryWriter.schedule(
      Object.fromEntries(Array.from(sessionHistoryMap.entries()).map(([key, value]) => [String(key), value])),
    )
  } catch (error) {
    console.error("保存会话历史失败:", error)
  }
}

export function listChatSessions(chatId: number, input: { workspace?: string } = {}) {
  const workspace = normalizeWorkspacePath(input.workspace)
  const records = normalizeRecords(sessionHistoryMap.get(chatId) || [])
  if (!workspace) return records
  return records.filter((record) => record.workspace === workspace)
}

export function rememberSession(
  chatId: number,
  sessionId: string,
  input: { label?: string; usedAt?: string; workspace?: string } = {},
) {
  const records = normalizeRecords(sessionHistoryMap.get(chatId) || [])
  const now = input.usedAt || new Date().toISOString()
  const workspace = normalizeWorkspacePath(input.workspace)
  const existing = records.find((record) => record.id === sessionId)

  if (existing) {
    existing.lastUsedAt = now
    existing.updatedAt = now
    if (input.label?.trim()) existing.label = input.label.trim()
    if (workspace) existing.workspace = workspace
  } else {
    records.push({
      id: sessionId,
      label: input.label?.trim() || defaultSessionLabel(sessionId),
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
      workspace,
    })
  }

  sessionHistoryMap.set(chatId, normalizeRecords(records))
  saveSessionHistory()
  return listChatSessions(chatId).find((record) => record.id === sessionId) || null
}

export function getSessionRecord(chatId: number, sessionId: string) {
  return listChatSessions(chatId).find((record) => record.id === sessionId) || null
}

export function getLatestSessionForWorkspace(chatId: number, workspace: string) {
  return listChatSessions(chatId, { workspace })[0] || null
}

export function flushAllPersistence() {
  sessionsWriter.flush()
  modelsWriter.flush()
  effortsWriter.flush()
  chatWorkingDirectoriesWriter.flush()
  chatPermissionModesWriter.flush()
  chatWorkspaceHistoryWriter.flush()
  sessionHistoryWriter.flush()
}
