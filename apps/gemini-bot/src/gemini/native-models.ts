import * as path from "path"
import { isJsonObject, readJsonFile, writeJsonFile } from "@matincz/telegram-bot-core/storage/json"

export const NATIVE_GEMINI_MODEL_OPTIONS = [
  "auto-gemini-3",
  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
  "auto-gemini-2.5",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
]

export function getGeminiSettingsPath(rootDir = process.cwd()) {
  return path.join(rootDir, ".gemini", "settings.json")
}

export function loadPersistedGeminiModel(rootDir = process.cwd()) {
  const parsed = readJsonFile(getGeminiSettingsPath(rootDir))
  const modelConfig = isJsonObject(parsed) && isJsonObject(parsed.model) ? parsed.model : undefined
  const modelName = modelConfig?.name
  return typeof modelName === "string" && modelName.trim() ? modelName.trim() : undefined
}

export function savePersistedGeminiModel(model: string, rootDir = process.cwd()) {
  const settingsPath = getGeminiSettingsPath(rootDir)
  const parsed = readJsonFile(settingsPath)
  const existing = isJsonObject(parsed) ? parsed : {}
  const nextValue = {
    ...existing,
    model: {
      ...(isJsonObject(existing.model) ? existing.model : {}),
      name: model,
    },
  }
  writeJsonFile(settingsPath, nextValue, { ensureDirectory: true })
}
