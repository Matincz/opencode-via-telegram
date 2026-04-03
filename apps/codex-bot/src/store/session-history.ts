import * as path from "path"
import { createDebouncedJsonWriter } from "@matincz/telegram-bot-core/storage/debounced-writer"
import { readJsonFile } from "@matincz/telegram-bot-core/storage/json"
import { normalizeWorkspacePath } from "./workspace-path"

const SESSION_HISTORY_FILE = path.join(process.cwd(), "session-history.json")
const sessionHistoryWriter = createDebouncedJsonWriter(SESSION_HISTORY_FILE)

export interface ChatSessionRecord {
  id: string
  label: string
  createdAt: string
  updatedAt: string
  lastUsedAt: string
  workspace?: string
}

export const sessionHistoryMap = new Map<number, ChatSessionRecord[]>()

function defaultSessionLabel(sessionId: string) {
  return `session-${sessionId.slice(0, 8)}`
}

function normalizeRecords(records: ChatSessionRecord[]) {
  return [...records].sort((a, b) => {
    if (a.lastUsedAt === b.lastUsedAt) {
      return a.createdAt.localeCompare(b.createdAt)
    }
    return b.lastUsedAt.localeCompare(a.lastUsedAt)
  })
}

function normalizeWorkspace(workspace?: string) {
  return normalizeWorkspacePath(workspace)
}

export function loadSessionHistory() {
  try {
    const parsed = readJsonFile(SESSION_HISTORY_FILE)
    if (!parsed || typeof parsed !== "object") return

    for (const [chatId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue
      const records = value
        .filter((record): record is ChatSessionRecord => {
          return Boolean(
            record
            && typeof record === "object"
            && typeof (record as ChatSessionRecord).id === "string"
            && typeof (record as ChatSessionRecord).label === "string",
          )
        })
        .map((record) => ({
          id: record.id,
          label: record.label.trim() || defaultSessionLabel(record.id),
          createdAt: record.createdAt || new Date().toISOString(),
          updatedAt: record.updatedAt || record.createdAt || new Date().toISOString(),
          lastUsedAt: record.lastUsedAt || record.updatedAt || record.createdAt || new Date().toISOString(),
          workspace: normalizeWorkspace(record.workspace),
        }))
      sessionHistoryMap.set(Number(chatId), normalizeRecords(records))
    }
    console.log(`🧵 已从本地加载了 ${sessionHistoryMap.size} 组 Codex 会话历史。`)
  } catch (error) {
    console.error("加载 Codex 会话历史失败:", error)
  }
}

export function saveSessionHistory() {
  try {
    sessionHistoryWriter.schedule(
      Object.fromEntries(Array.from(sessionHistoryMap.entries()).map(([chatId, records]) => [String(chatId), records])),
    )
  } catch (error) {
    console.error("保存 Codex 会话历史失败:", error)
  }
}

export function flushSessionHistory() {
  sessionHistoryWriter.flush()
}

export function listChatSessions(chatId: number, input: { workspace?: string } = {}) {
  const workspace = normalizeWorkspace(input.workspace)
  const records = normalizeRecords(sessionHistoryMap.get(chatId) || [])
  if (!workspace) return records
  return records.filter((record) => record.workspace === workspace)
}

export function rememberSession(chatId: number, sessionId: string, input: { label?: string; usedAt?: string; workspace?: string } = {}) {
  const records = normalizeRecords(sessionHistoryMap.get(chatId) || [])
  const now = input.usedAt || new Date().toISOString()
  const workspace = normalizeWorkspace(input.workspace)
  const existing = records.find((record) => record.id === sessionId)

  if (existing) {
    existing.lastUsedAt = now
    existing.updatedAt = now
    if (input.label?.trim()) {
      existing.label = input.label.trim()
    }
    if (workspace) {
      existing.workspace = workspace
    }
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

export function renameSession(chatId: number, sessionId: string, label: string) {
  const records = listChatSessions(chatId)
  const target = records.find((record) => record.id === sessionId)
  if (!target) return null
  target.label = label.trim() || defaultSessionLabel(sessionId)
  target.updatedAt = new Date().toISOString()
  sessionHistoryMap.set(chatId, normalizeRecords(records))
  saveSessionHistory()
  return target
}

export function getSessionRecord(chatId: number, sessionId: string) {
  return listChatSessions(chatId).find((record) => record.id === sessionId) || null
}

export function getLatestSessionForWorkspace(chatId: number, workspace: string) {
  return listChatSessions(chatId, { workspace })[0] || null
}
