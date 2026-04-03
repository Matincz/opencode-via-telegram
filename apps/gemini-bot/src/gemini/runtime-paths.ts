import * as fs from "fs"
import * as os from "os"
import * as path from "path"

export function getGeminiCliHome(rootDir = process.cwd()) {
  const raw = String(process.env.GEMINI_CLI_HOME || "").trim()
  if (!raw) {
    return os.homedir()
  }
  return path.isAbsolute(raw) ? raw : path.join(rootDir, raw)
}

export function ensureGeminiCliHome(rootDir = process.cwd()) {
  const cliHome = getGeminiCliHome(rootDir)
  fs.mkdirSync(cliHome, { recursive: true })
  return cliHome
}

export function getGeminiCliDataDir(rootDir = process.cwd()) {
  return path.join(getGeminiCliHome(rootDir), ".gemini")
}

export function ensureGeminiCliDataDir(rootDir = process.cwd()) {
  const dir = getGeminiCliDataDir(rootDir)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function applyGeminiCliHome(rootDir = process.cwd()) {
  const cliHome = ensureGeminiCliHome(rootDir)
  ensureGeminiCliDataDir(rootDir)
  process.env.GEMINI_CLI_HOME = cliHome
  return cliHome
}

export function getPlanArtifactsDir(rootDir = process.cwd()) {
  return path.join(rootDir, "artifacts", "plans")
}

export function ensurePlanArtifactsDir(rootDir = process.cwd()) {
  const dir = getPlanArtifactsDir(rootDir)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
