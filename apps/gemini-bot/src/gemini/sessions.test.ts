import { describe, expect, it } from "bun:test"
import { parseGeminiSessionsOutput, resolveGeminiSessionIdentifier } from "./sessions"

const SAMPLE_OUTPUT = `
Loaded cached credentials.

Available sessions for this project (2):
  1. First prompt summary (1 hour ago) [fcdd4a5c-08e7-4077-9e20-54d472dacc18]
  2. Second prompt summary (2 minutes ago) [de53b3e6-961e-435b-8eab-d39500f3fcb4]
`

describe("parseGeminiSessionsOutput", () => {
  it("extracts session rows from gemini --list-sessions output", () => {
    const sessions = parseGeminiSessionsOutput(SAMPLE_OUTPUT)

    expect(sessions).toEqual([
      {
        index: 1,
        summary: "First prompt summary",
        relativeTime: "1 hour ago",
        sessionId: "fcdd4a5c-08e7-4077-9e20-54d472dacc18",
      },
      {
        index: 2,
        summary: "Second prompt summary",
        relativeTime: "2 minutes ago",
        sessionId: "de53b3e6-961e-435b-8eab-d39500f3fcb4",
      },
    ])
  })
})

describe("resolveGeminiSessionIdentifier", () => {
  const sessions = parseGeminiSessionsOutput(SAMPLE_OUTPUT)

  it("resolves latest", () => {
    expect(resolveGeminiSessionIdentifier(sessions, "latest")?.index).toBe(2)
  })

  it("resolves numeric indexes", () => {
    expect(resolveGeminiSessionIdentifier(sessions, "1")?.sessionId).toBe("fcdd4a5c-08e7-4077-9e20-54d472dacc18")
  })

  it("resolves raw session ids", () => {
    expect(resolveGeminiSessionIdentifier(sessions, "de53b3e6-961e-435b-8eab-d39500f3fcb4")?.index).toBe(2)
  })
})
