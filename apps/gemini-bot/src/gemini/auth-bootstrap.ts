import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { isJsonObject, readJsonFile, writeJsonFile } from "@matincz/telegram-bot-core/storage/json"
import { ensureGeminiCliDataDir } from "./runtime-paths"

const AUTH_FILE_NAMES = [
  "oauth_creds.json",
  "google_accounts.json",
  "state.json",
  "installation_id",
] as const

function getDefaultGeminiDataDir() {
  return path.join(os.homedir(), ".gemini")
}

export function bootstrapGeminiCliAuth(rootDir = process.cwd()) {
  const sourceDir = getDefaultGeminiDataDir()
  const targetDir = ensureGeminiCliDataDir(rootDir)
  const sourceSettingsPath = path.join(sourceDir, "settings.json")
  const targetSettingsPath = path.join(targetDir, "settings.json")
  const sourceSettings = readJsonFile(sourceSettingsPath)
  const targetSettings = readJsonFile(targetSettingsPath)
  const source = isJsonObject(sourceSettings) ? sourceSettings : {}
  const target = isJsonObject(targetSettings) ? targetSettings : {}
  const sourceSecurity = isJsonObject(source.security) ? source.security : {}
  const targetSecurity = isJsonObject(target.security) ? target.security : {}
  const sourceAuth = isJsonObject(sourceSecurity.auth) ? sourceSecurity.auth : {}
  const targetAuth = isJsonObject(targetSecurity.auth) ? targetSecurity.auth : {}
  const selectedType = typeof sourceAuth.selectedType === "string" && sourceAuth.selectedType.trim()
    ? sourceAuth.selectedType.trim()
    : typeof targetAuth.selectedType === "string" && targetAuth.selectedType.trim()
      ? targetAuth.selectedType.trim()
      : null

  if (selectedType) {
    writeJsonFile(targetSettingsPath, {
      ...target,
      security: {
        ...targetSecurity,
        auth: {
          ...targetAuth,
          selectedType,
        },
      },
    }, { ensureDirectory: true })
  }

  let copiedFiles = 0
  for (const fileName of AUTH_FILE_NAMES) {
    const sourcePath = path.join(sourceDir, fileName)
    const targetPath = path.join(targetDir, fileName)
    if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) continue
    fs.copyFileSync(sourcePath, targetPath)
    copiedFiles += 1
  }

  return {
    selectedType,
    copiedFiles,
    sourceDir,
    targetDir,
  }
}
