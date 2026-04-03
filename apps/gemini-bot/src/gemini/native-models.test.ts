import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import * as os from "os"
import * as path from "path"
import { loadPersistedGeminiModel, savePersistedGeminiModel } from "./native-models"

describe("native model settings", () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("persists the selected model into .gemini/settings.json", () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "gemini-native-models-"))
    tempDirs.push(rootDir)

    savePersistedGeminiModel("gemini-3.1-pro-preview", rootDir)

    expect(loadPersistedGeminiModel(rootDir)).toBe("gemini-3.1-pro-preview")
  })
})
