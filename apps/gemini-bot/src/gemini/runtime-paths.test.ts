import { describe, expect, test } from "bun:test"
import * as os from "os"
import { getGeminiCliHome } from "./runtime-paths"

describe("runtime-paths", () => {
  test("defaults CLI home into the user's home directory", () => {
    const previous = process.env.GEMINI_CLI_HOME
    delete process.env.GEMINI_CLI_HOME
    expect(getGeminiCliHome("/tmp/project")).toBe(os.homedir())
    if (previous) {
      process.env.GEMINI_CLI_HOME = previous
    }
  })
})
