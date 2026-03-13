import { describe, expect, it } from "bun:test"
import {
  buildBasicAuthHeader,
  getDesktopGlobalStatePath,
  getDesktopStateDir,
  getDesktopSettingsPath,
  mergeProjectLists,
  parseDesktopLocalProjects,
  parseDesktopSettingsServerUrl,
  parseDesktopSidecarBackend,
  parseDesktopSidecarPidList,
} from "./backend"

describe("parseDesktopSidecarPidList", () => {
  it("finds desktop sidecar pids and sorts newest first", () => {
    const output = [
      "28425 /Applications/OpenCode.app/Contents/MacOS/opencode-cli --print-logs --log-level WARN serve --hostname 127.0.0.1 --port 54613",
      "828 /Users/demo/.opencode/bin/opencode serve --port 4096",
      "30001 /Applications/OpenCode.app/Contents/MacOS/opencode-cli serve --hostname 127.0.0.1 --port 56000",
    ].join("\n")

    expect(parseDesktopSidecarPidList(output)).toEqual([30001, 28425])
  })
})

describe("parseDesktopSidecarBackend", () => {
  it("extracts sidecar url and basic auth header from ps output", () => {
    const output = [
      "PID TT STAT TIME COMMAND",
      "28425 ?? S 1:04.30 /Applications/OpenCode.app/Contents/MacOS/opencode-cli --print-logs --log-level WARN serve --hostname 127.0.0.1 --port 54613 OPENCODE_SERVER_PASSWORD=secret-value OPENCODE_SERVER_USERNAME=opencode",
    ].join("\n")

    expect(parseDesktopSidecarBackend(output)).toEqual({
      baseUrl: "http://127.0.0.1:54613",
      headers: { Authorization: buildBasicAuthHeader("opencode", "secret-value") },
      source: "desktop-sidecar",
    })
  })

  it("returns null when required fields are missing", () => {
    expect(parseDesktopSidecarBackend("")).toBeNull()
    expect(parseDesktopSidecarBackend("OPENCODE_SERVER_PASSWORD=only-password")).toBeNull()
  })
})

describe("parseDesktopSettingsServerUrl", () => {
  it("reads defaultServerUrl from settings json", () => {
    expect(parseDesktopSettingsServerUrl(JSON.stringify({ defaultServerUrl: "http://127.0.0.1:4096" }))).toBe(
      "http://127.0.0.1:4096",
    )
  })

  it("ignores invalid settings payloads", () => {
    expect(parseDesktopSettingsServerUrl("{}")).toBeUndefined()
    expect(parseDesktopSettingsServerUrl("not-json")).toBeUndefined()
  })
})

describe("getDesktopSettingsPath", () => {
  it("builds the macOS desktop settings path", () => {
    expect(getDesktopSettingsPath("/Users/demo", "darwin")).toBe(
      "/Users/demo/Library/Application Support/ai.opencode.desktop/opencode.settings.dat",
    )
  })
})

describe("desktop project state helpers", () => {
  it("builds the desktop state paths", () => {
    expect(getDesktopStateDir("/Users/demo", "darwin")).toBe(
      "/Users/demo/Library/Application Support/ai.opencode.desktop",
    )
    expect(getDesktopGlobalStatePath("/Users/demo", "darwin")).toBe(
      "/Users/demo/Library/Application Support/ai.opencode.desktop/opencode.global.dat",
    )
  })

  it("parses local desktop projects from the global state file", () => {
    const raw = JSON.stringify({
      server: JSON.stringify({
        projects: {
          local: [
            { worktree: "/Users/demo/Desktop" },
            { worktree: "/Users/demo/Documents", vcs: "git" },
          ],
        },
      }),
    })

    expect(parseDesktopLocalProjects(raw)).toEqual([
      { id: "/Users/demo/Desktop", worktree: "/Users/demo/Desktop", vcs: undefined, source: "desktop-local" },
      { id: "/Users/demo/Documents", worktree: "/Users/demo/Documents", vcs: "git", source: "desktop-local" },
    ])
  })

  it("merges desktop-local projects without duplicating backend projects", () => {
    expect(mergeProjectLists(
      [
        { id: "global", worktree: "/" },
        { id: "proj-1", worktree: "/Users/demo/Desktop", source: "backend" },
      ],
      [
        { id: "/Users/demo/Desktop", worktree: "/Users/demo/Desktop", source: "desktop-local" },
        { id: "/Users/demo/Documents", worktree: "/Users/demo/Documents", source: "desktop-local" },
      ],
    )).toEqual([
      { id: "global", worktree: "/", source: "backend" },
      { id: "proj-1", worktree: "/Users/demo/Desktop", source: "backend" },
      { id: "/Users/demo/Documents", worktree: "/Users/demo/Documents", source: "desktop-local" },
    ])
  })
})
