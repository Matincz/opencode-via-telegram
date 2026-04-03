import * as path from "path"
import { createDebouncedJsonWriter } from "@matincz/telegram-bot-core/storage/debounced-writer"
import { readJsonFile } from "@matincz/telegram-bot-core/storage/json"

export interface CodexAgentProfile {
  name: string
  cwd?: string
  model?: string
  reasoningEffort?: string
  sessionId?: string
  createdAt: string
  updatedAt: string
  lastRunAt?: string
}

const AGENTS_FILE = path.join(process.cwd(), "agents.json")
const agentsWriter = createDebouncedJsonWriter(AGENTS_FILE)

export const agentProfileMap = new Map<number, CodexAgentProfile[]>()

function normalizeName(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
}

function sortProfiles(profiles: CodexAgentProfile[]) {
  return [...profiles].sort((a, b) => a.name.localeCompare(b.name))
}

export function loadAgentProfiles() {
  try {
    const parsed = readJsonFile(AGENTS_FILE)
    if (!parsed || typeof parsed !== "object") return
    for (const [chatId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue
      const profiles = value
        .filter((item): item is CodexAgentProfile => Boolean(item && typeof item === "object" && typeof (item as CodexAgentProfile).name === "string"))
        .map((item) => ({
          name: normalizeName(item.name),
          cwd: item.cwd,
          model: item.model,
          reasoningEffort: item.reasoningEffort,
          sessionId: item.sessionId,
          createdAt: item.createdAt || new Date().toISOString(),
          updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
          lastRunAt: item.lastRunAt,
        }))
        .filter((item) => item.name)
      agentProfileMap.set(Number(chatId), sortProfiles(profiles))
    }
    console.log(`🧩 已从本地加载了 ${agentProfileMap.size} 组 agent 配置。`)
  } catch (error) {
    console.error("加载 agent 配置失败:", error)
  }
}

export function saveAgentProfiles() {
  try {
    agentsWriter.schedule(
      Object.fromEntries(Array.from(agentProfileMap.entries()).map(([chatId, profiles]) => [String(chatId), profiles])),
    )
  } catch (error) {
    console.error("保存 agent 配置失败:", error)
  }
}

export function flushAgentProfiles() {
  agentsWriter.flush()
}

export function listAgentProfiles(chatId: number) {
  return sortProfiles(agentProfileMap.get(chatId) || [])
}

export function getAgentProfile(chatId: number, name: string) {
  const normalizedName = normalizeName(name)
  return listAgentProfiles(chatId).find((profile) => profile.name === normalizedName) || null
}

export function upsertAgentProfile(chatId: number, input: {
  name: string
  cwd?: string
  model?: string
  reasoningEffort?: string
  sessionId?: string
  lastRunAt?: string
}) {
  const name = normalizeName(input.name)
  if (!name) {
    throw new Error("Agent 名称不能为空。")
  }

  const profiles = listAgentProfiles(chatId)
  const existing = profiles.find((profile) => profile.name === name)
  const now = new Date().toISOString()

  if (existing) {
    existing.cwd = input.cwd ?? existing.cwd
    existing.model = input.model ?? existing.model
    existing.reasoningEffort = input.reasoningEffort ?? existing.reasoningEffort
    existing.sessionId = input.sessionId ?? existing.sessionId
    existing.lastRunAt = input.lastRunAt ?? existing.lastRunAt
    existing.updatedAt = now
  } else {
    profiles.push({
      name,
      cwd: input.cwd,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      sessionId: input.sessionId,
      createdAt: now,
      updatedAt: now,
      lastRunAt: input.lastRunAt,
    })
  }

  agentProfileMap.set(chatId, sortProfiles(profiles))
  saveAgentProfiles()
  return getAgentProfile(chatId, name)
}

export function removeAgentProfile(chatId: number, name: string) {
  const normalizedName = normalizeName(name)
  const profiles = listAgentProfiles(chatId)
  const next = profiles.filter((profile) => profile.name !== normalizedName)
  if (next.length === profiles.length) return null
  agentProfileMap.set(chatId, next)
  saveAgentProfiles()
  return normalizedName
}
