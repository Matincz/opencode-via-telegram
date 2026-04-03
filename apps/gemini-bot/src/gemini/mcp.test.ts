import { describe, expect, test } from "bun:test"
import { getGeminiConfigSnapshot } from "./mcp"

describe("mcp config", () => {
  test("returns empty snapshot when no config exists", () => {
    const snapshot = getGeminiConfigSnapshot({
      rootDir: "/tmp/does-not-exist-gemini-project",
      cliHome: "/tmp/does-not-exist-gemini-home",
    })

    expect(snapshot.mcpServers).toEqual([])
    expect(snapshot.includeTools).toEqual([])
    expect(snapshot.excludeTools).toEqual([])
    expect(snapshot.yoloDisabled).toBe(false)
  })
})
