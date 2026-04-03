import * as path from "path"
import { readJsonFile } from "@matincz/telegram-bot-core/storage/json"
import { createDebouncedJsonWriter } from "@matincz/telegram-bot-core/storage/debounced-writer"
import { flushSnapshotPersistence } from "./snapshots"

const SESSIONS_FILE = path.join(process.cwd(), "sessions-map.json")
const SELECTED_MODELS_FILE = path.join(process.cwd(), "selected-models.json")
const CHAT_HISTORIES_FILE = path.join(process.cwd(), "chat-histories.json")

const sessionsWriter = createDebouncedJsonWriter(SESSIONS_FILE)
const modelsWriter = createDebouncedJsonWriter(SELECTED_MODELS_FILE)
const historiesWriter = createDebouncedJsonWriter(CHAT_HISTORIES_FILE, 500)

export interface ChatHistoryEntry {
  role: "user" | "assistant"
  text: string
  createdAt: string
}

export const sessionMap = new Map<number, string>()
export const selectedModelMap = new Map<number, string>()
export const chatHistoryMap = new Map<number, ChatHistoryEntry[]>()

export function generateSessionId() {
  return `gem_ses_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function setChatSession(chatId: number, sessionId: string) {
  sessionMap.set(chatId, sessionId)
}

export function ensureChatSession(chatId: number) {
  const existing = sessionMap.get(chatId)
  if (existing) return existing
  const sessionId = generateSessionId()
  setChatSession(chatId, sessionId)
  saveSessions()
  return sessionId
}

export function clearChatSession(chatId: number) {
  const changed = sessionMap.delete(chatId)
  chatHistoryMap.delete(chatId)
  saveSessions()
  saveChatHistories()
  return changed
}

export function appendChatHistory(chatId: number, entry: ChatHistoryEntry) {
  const existing = chatHistoryMap.get(chatId) || []
  existing.push(entry)
  chatHistoryMap.set(chatId, existing.slice(-20))
  saveChatHistories()
}

export function getChatHistory(chatId: number) {
  return chatHistoryMap.get(chatId) || []
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
    console.log(`📂 已从本地加载了 ${sessionMap.size} 个历史会话记录。`)
  } catch (error) {
    console.error("加载会话记录失败:", error)
  }
}

export function saveSessions() {
  try {
    const value = Object.fromEntries(Array.from(sessionMap.entries()).map(([key, sessionId]) => [String(key), sessionId]))
    sessionsWriter.schedule(value)
  } catch (error) {
    console.error("保存会话记录失败:", error)
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
    console.log(`🤖 已从本地加载了 ${selectedModelMap.size} 个模型选择记录。`)
  } catch (error) {
    console.error("加载模型选择记录失败:", error)
  }
}

export function saveSelectedModels() {
  try {
    const value = Object.fromEntries(Array.from(selectedModelMap.entries()).map(([key, model]) => [String(key), model]))
    modelsWriter.schedule(value)
  } catch (error) {
    console.error("保存模型选择记录失败:", error)
  }
}

export function loadChatHistories() {
  try {
    const parsed = readJsonFile(CHAT_HISTORIES_FILE)
    if (!parsed) return
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue
      const entries = value.filter((item) =>
        item
        && (item.role === "user" || item.role === "assistant")
        && typeof item.text === "string"
        && typeof item.createdAt === "string",
      ) as ChatHistoryEntry[]
      chatHistoryMap.set(Number(key), entries)
    }
    console.log(`🧠 已从本地加载了 ${chatHistoryMap.size} 个聊天历史。`)
  } catch (error) {
    console.error("加载聊天历史失败:", error)
  }
}

export function saveChatHistories() {
  try {
    const value = Object.fromEntries(Array.from(chatHistoryMap.entries()).map(([key, history]) => [String(key), history]))
    historiesWriter.schedule(value)
  } catch (error) {
    console.error("保存聊天历史失败:", error)
  }
}

export function flushAllPersistence() {
  sessionsWriter.flush()
  modelsWriter.flush()
  historiesWriter.flush()
  flushSnapshotPersistence()
}
