import { describe, expect, it } from "bun:test"
import { getProjectDisplayName } from "./project-session"

describe("getProjectDisplayName", () => {
  it("keeps root readable", () => {
    expect(getProjectDisplayName("/")).toBe("/")
  })

  it("keeps single segment paths readable", () => {
    expect(getProjectDisplayName("/repo")).toBe("/repo")
  })

  it("compresses deep paths to the last two segments", () => {
    expect(getProjectDisplayName("/Users/demo/opencode-via-telegram")).toBe(".../demo/opencode-via-telegram")
  })
})
