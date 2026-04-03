import * as path from "path"
import { readJsonFile } from "@matincz/telegram-bot-core/storage/json"
import { createDebouncedJsonWriter } from "@matincz/telegram-bot-core/storage/debounced-writer"
import type { ChatHistoryEntry } from "./runtime-state"

const CHECKPOINTS_FILE = path.join(process.cwd(), "checkpoints.json")
const REWIND_SNAPSHOTS_FILE = path.join(process.cwd(), "rewind-snapshots.json")

const checkpointsWriter = createDebouncedJsonWriter(CHECKPOINTS_FILE, 500)
const rewindWriter = createDebouncedJsonWriter(REWIND_SNAPSHOTS_FILE, 500)

export interface StoredChatSnapshot {
  id: string
  title: string
  createdAt: string
  model: string | null
  history: ChatHistoryEntry[]
}

export const checkpointMap = new Map<number, StoredChatSnapshot[]>()
export const rewindSnapshotMap = new Map<number, StoredChatSnapshot[]>()

function normalizeSnapshot(raw: any): StoredChatSnapshot | null {
  if (!raw || typeof raw !== "object") return null
  if (typeof raw.id !== "string" || !raw.id.trim()) return null
  if (typeof raw.title !== "string" || !raw.title.trim()) return null
  if (typeof raw.createdAt !== "string" || !raw.createdAt.trim()) return null
  if (!Array.isArray(raw.history)) return null

  const history = raw.history.filter((item: any) =>
    item && typeof item === "object"
    && (item.role === "user" || item.role === "assistant")
    && typeof item.text === "string"
    && typeof item.createdAt === "string",
  ) as ChatHistoryEntry[]

  return {
    id: raw.id.trim(),
    title: raw.title.trim(),
    createdAt: raw.createdAt.trim(),
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : null,
    history,
  }
}

function loadSnapshotMap(filePath: string, target: Map<number, StoredChatSnapshot[]>) {
  const parsed = readJsonFile(filePath)
  if (!parsed) return

  for (const [key, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) continue
    const snapshots = value
      .map((item) => normalizeSnapshot(item))
      .filter(Boolean) as StoredChatSnapshot[]

    target.set(Number(key), snapshots)
  }
}

function saveSnapshotMap(writer: ReturnType<typeof createDebouncedJsonWriter>, source: Map<number, StoredChatSnapshot[]>) {
  const value = Object.fromEntries(Array.from(source.entries()).map(([key, snapshots]) => [String(key), snapshots]))
  writer.schedule(value)
}

function createSnapshotId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function loadCheckpoints() {
  try {
    loadSnapshotMap(CHECKPOINTS_FILE, checkpointMap)
    console.log(`📌 已从本地加载了 ${checkpointMap.size} 个 checkpoint 集合。`)
  } catch (error) {
    console.error("加载 checkpoints 失败:", error)
  }
}

export function saveCheckpoints() {
  try {
    saveSnapshotMap(checkpointsWriter, checkpointMap)
  } catch (error) {
    console.error("保存 checkpoints 失败:", error)
  }
}

export function loadRewindSnapshots() {
  try {
    loadSnapshotMap(REWIND_SNAPSHOTS_FILE, rewindSnapshotMap)
    console.log(`⏪ 已从本地加载了 ${rewindSnapshotMap.size} 个 rewind 快照集合。`)
  } catch (error) {
    console.error("加载 rewind 快照失败:", error)
  }
}

export function saveRewindSnapshots() {
  try {
    saveSnapshotMap(rewindWriter, rewindSnapshotMap)
  } catch (error) {
    console.error("保存 rewind 快照失败:", error)
  }
}

export function flushSnapshotPersistence() {
  checkpointsWriter.flush()
  rewindWriter.flush()
}

export function listCheckpoints(chatId: number) {
  return checkpointMap.get(chatId) || []
}

export function getCheckpointById(chatId: number, id: string) {
  return listCheckpoints(chatId).find((item) => item.id === id)
}

export function saveCheckpoint(chatId: number, title: string, history: ChatHistoryEntry[], model: string | null) {
  const normalizedTitle = title.trim()
  const createdAt = new Date().toISOString()
  const nextSnapshot: StoredChatSnapshot = {
    id: createSnapshotId("cp"),
    title: normalizedTitle,
    createdAt,
    model,
    history: history.slice(),
  }

  const existing = listCheckpoints(chatId)
  const replaced = existing.some((item) => item.title === normalizedTitle)
    ? existing.map((item) => item.title === normalizedTitle ? { ...nextSnapshot, id: item.id } : item)
    : [...existing, nextSnapshot]

  checkpointMap.set(chatId, replaced)
  saveCheckpoints()
  return replaced.find((item) => item.title === normalizedTitle)!
}

export function deleteCheckpoint(chatId: number, id: string) {
  const existing = listCheckpoints(chatId)
  const next = existing.filter((item) => item.id !== id)
  checkpointMap.set(chatId, next)
  saveCheckpoints()
}

export function listRewindSnapshots(chatId: number) {
  return rewindSnapshotMap.get(chatId) || []
}

export function getRewindSnapshotById(chatId: number, id: string) {
  return listRewindSnapshots(chatId).find((item) => item.id === id)
}

export function pushRewindSnapshot(
  chatId: number,
  input: { title: string; history: ChatHistoryEntry[]; model: string | null; limit?: number },
) {
  const nextSnapshot: StoredChatSnapshot = {
    id: createSnapshotId("rw"),
    title: input.title.trim() || "未命名快照",
    createdAt: new Date().toISOString(),
    model: input.model,
    history: input.history.slice(),
  }

  const limit = input.limit || 12
  const existing = listRewindSnapshots(chatId)
  const next = [...existing, nextSnapshot].slice(-limit)
  rewindSnapshotMap.set(chatId, next)
  saveRewindSnapshots()
  return nextSnapshot
}
