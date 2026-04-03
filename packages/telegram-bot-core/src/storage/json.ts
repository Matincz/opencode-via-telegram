import * as fs from "fs"
import * as path from "path"

export function isJsonObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function readJsonFile(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, "utf-8"))
}

export function readJsonObjectFile(filePath: string): Record<string, any> | undefined {
  try {
    const parsed = readJsonFile(filePath)
    return isJsonObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function writeJsonFile(filePath: string, value: unknown, options?: { ensureDirectory?: boolean }) {
  if (options?.ensureDirectory) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
  }
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8")
}
