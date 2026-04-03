import * as fs from "fs"
import * as path from "path"

export function normalizeWorkspacePath(workspace?: string) {
  const trimmed = workspace?.trim()
  if (!trimmed) return undefined

  const resolved = path.resolve(trimmed)
  try {
    return fs.realpathSync.native(resolved)
  } catch {
    return resolved
  }
}
