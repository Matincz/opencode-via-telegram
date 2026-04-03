import { describe, expect, it } from "bun:test"
import { tokenizeCronArgs } from "./client"

describe("tokenizeCronArgs", () => {
  it("keeps quoted values together", () => {
    expect(tokenizeCronArgs('--name "daily report" --schedule "0 9 * * *"')).toEqual([
      "--name",
      "daily report",
      "--schedule",
      "0 9 * * *",
    ])
  })

  it("supports single quotes too", () => {
    expect(tokenizeCronArgs("--title 'Morning Run' --provider codex")).toEqual([
      "--title",
      "Morning Run",
      "--provider",
      "codex",
    ])
  })
})
