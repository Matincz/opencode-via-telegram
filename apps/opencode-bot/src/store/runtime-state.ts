import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { readJsonFile, writeJsonFile } from "@matincz/telegram-bot-core/storage/json"

const HOME_DIR = path.resolve(os.homedir())
const SESSIONS_FILE = path.join(process.cwd(), "sessions-map.json")
const SELECTED_MODELS_FILE = path.join(process.cwd(), "selected-models.json")
const SELECTED_AGENTS_FILE = path.join(process.cwd(), "selected-agents.json")
const ACTIVE_PROJECTS_FILE = path.join(process.cwd(), "active-projects.json")

export const sessionMap = new Map<number, string>()
const sessionChatMap = new Map<string, number>()
export const selectedModelMap = new Map<number, string>()
export const selectedAgentMap = new Map<number, string>()
export const activeProjectMap = new Map<number, string>()
const activeProjectWorktreeCache = new Map<number, string>()
export const pendingQuestionRequests = new Map<
  string,
  {
    chatId: number
    sessionId: string
    text: string
    messageId?: number
  }
>()
export const chatAwaitingQuestionInput = new Map<number, { requestId: string; sessionId: string }>()

export function setChatSession(chatId: number, sessionId: string) {
  const existing = sessionMap.get(chatId)
  if (existing && existing !== sessionId) {
    sessionChatMap.delete(existing)
  }
  sessionMap.set(chatId, sessionId)
  sessionChatMap.set(sessionId, chatId)
}

export function clearChatSession(chatId: number) {
  const existing = sessionMap.get(chatId)
  if (!existing) return false
  sessionMap.delete(chatId)
  sessionChatMap.delete(existing)
  return true
}

export function getChatIdForSession(sessionId: string) {
  return sessionChatMap.get(sessionId) || 0
}

export function loadSessions() {
  try {
    const parsed = readJsonFile(SESSIONS_FILE)
    if (!parsed || typeof parsed !== "object") return
    for (const key of Object.keys(parsed)) {
      setChatSession(Number(key), parsed[key])
    }
    console.log(`📂 已从本地加载了 ${sessionMap.size} 个历史会话记录。`)
  } catch (err) {
    console.error("加载会话记录失败:", err)
  }
}

export function saveSessions() {
  try {
    const obj: Record<string, string> = {}
    for (const [key, value] of Array.from(sessionMap.entries())) obj[String(key)] = value
    writeJsonFile(SESSIONS_FILE, obj)
  } catch (err) {
    console.error("保存会话记录失败:", err)
  }
}

export function loadSelectedModels() {
  try {
    const parsed = readJsonFile(SELECTED_MODELS_FILE)
    if (!parsed || typeof parsed !== "object") return
    for (const key of Object.keys(parsed)) {
      if (typeof parsed[key] === "string" && parsed[key].includes("/")) {
        selectedModelMap.set(Number(key), parsed[key])
      }
    }
    console.log(`🤖 已从本地加载了 ${selectedModelMap.size} 个模型选择记录。`)
  } catch (err) {
    console.error("加载模型选择记录失败:", err)
  }
}

export function saveSelectedModels() {
  try {
    const obj: Record<string, string> = {}
    for (const [key, value] of Array.from(selectedModelMap.entries())) obj[String(key)] = value
    writeJsonFile(SELECTED_MODELS_FILE, obj)
  } catch (err) {
    console.error("保存模型选择记录失败:", err)
  }
}

export function loadSelectedAgents() {
  try {
    const parsed = readJsonFile(SELECTED_AGENTS_FILE)
    if (!parsed || typeof parsed !== "object") return
    for (const key of Object.keys(parsed)) {
      if (typeof parsed[key] === "string" && parsed[key].trim()) {
        selectedAgentMap.set(Number(key), parsed[key].trim())
      }
    }
    console.log(`🧭 已从本地加载了 ${selectedAgentMap.size} 个模式选择记录。`)
  } catch (err) {
    console.error("加载模式选择记录失败:", err)
  }
}

export function saveSelectedAgents() {
  try {
    const obj: Record<string, string> = {}
    for (const [key, value] of Array.from(selectedAgentMap.entries())) obj[String(key)] = value
    writeJsonFile(SELECTED_AGENTS_FILE, obj)
  } catch (err) {
    console.error("保存模式选择记录失败:", err)
  }
}

export function loadActiveProjects() {
  try {
    const parsed = readJsonFile(ACTIVE_PROJECTS_FILE)
    if (!parsed || typeof parsed !== "object") return
    for (const key of Object.keys(parsed)) {
      if (typeof parsed[key] === "string") {
        activeProjectMap.set(Number(key), parsed[key])
      }
    }
    console.log(`📁 已从本地加载了 ${activeProjectMap.size} 个项目选择记录。`)
  } catch (err) {
    console.error("加载项目选择记录失败:", err)
  }
}

export function saveActiveProjects() {
  try {
    const obj: Record<string, string> = {}
    for (const [key, value] of Array.from(activeProjectMap.entries())) obj[String(key)] = value
    writeJsonFile(ACTIVE_PROJECTS_FILE, obj)
  } catch (err) {
    console.error("保存项目选择记录失败:", err)
  }
}

export function cacheActiveProjectWorktree(chatId: number, worktree: string) {
  activeProjectWorktreeCache.set(chatId, path.resolve(worktree))
}

export function getCachedActiveProjectWorktree(chatId: number) {
  return activeProjectWorktreeCache.get(chatId)
}

export function setActiveProjectSelection(chatId: number, projectId: string, worktree?: string) {
  activeProjectMap.set(chatId, projectId)
  if (worktree) cacheActiveProjectWorktree(chatId, worktree)
  else activeProjectWorktreeCache.delete(chatId)
  saveActiveProjects()
}

export function clearActiveProjectSelection(chatId: number) {
  activeProjectWorktreeCache.delete(chatId)
  if (!activeProjectMap.delete(chatId)) return
  saveActiveProjects()
}

export function clearQuestionState(chatId: number, requestId?: string) {
  const awaiting = chatAwaitingQuestionInput.get(chatId)
  if (!requestId) {
    chatAwaitingQuestionInput.delete(chatId)
    for (const [id, state] of Array.from(pendingQuestionRequests.entries())) {
      if (state.chatId === chatId) pendingQuestionRequests.delete(id)
    }
    return
  }

  if (awaiting?.requestId === requestId) {
    chatAwaitingQuestionInput.delete(chatId)
  }
  const existing = pendingQuestionRequests.get(requestId)
  if (existing?.chatId === chatId) {
    pendingQuestionRequests.delete(requestId)
  }
}

export function isOverlyBroadProjectWorktree(worktree?: string): boolean {
  if (!worktree) return false
  const resolved = path.resolve(worktree)
  return resolved === path.parse(resolved).root || resolved === HOME_DIR
}
