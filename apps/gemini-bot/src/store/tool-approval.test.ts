import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import * as os from "os"
import * as path from "path"
import {
  clearToolApprovalPreference,
  getToolApprovalPreference,
  loadToolApprovalPreferences,
  resetToolApprovalPreferences,
  setToolApprovalPreferenceForRoot,
  shouldAlwaysApproveTools,
} from "./tool-approval"

const tempDirs: string[] = []

afterEach(async () => {
  resetToolApprovalPreferences()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("tool approval preferences", () => {
  test("persists always-approve preference", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "tg-approval-"))
    tempDirs.push(rootDir)

    setToolApprovalPreferenceForRoot(123, "always", rootDir)
    loadToolApprovalPreferences(rootDir)
    expect(shouldAlwaysApproveTools(123)).toBe(true)
  })

  test("loads and clears preference from a custom root", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "tg-approval-"))
    tempDirs.push(rootDir)

    resetToolApprovalPreferences()
    const filePath = path.join(rootDir, "tool-approval-preferences.json")
    await Bun.write(filePath, JSON.stringify({ "456": "always" }, null, 2))

    loadToolApprovalPreferences(rootDir)
    expect(getToolApprovalPreference(456)).toBe("always")

    clearToolApprovalPreference(456, rootDir)
    expect(getToolApprovalPreference(456)).toBeUndefined()
  })
})
