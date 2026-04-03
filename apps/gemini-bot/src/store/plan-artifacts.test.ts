import { describe, expect, test } from "bun:test"
import { extractPlanTodos } from "./plan-artifacts"

describe("plan-artifacts", () => {
  test("extracts numbered plan steps into todos", () => {
    const todos = extractPlanTodos([
      "Goal: do something",
      "Proposed steps:",
      "1. Read the target files",
      "2. Update the implementation",
      "3. Run tests",
    ].join("\n"))

    expect(todos.length).toBe(3)
    expect(todos[0]?.text).toContain("Read the target files")
    expect(todos[2]?.text).toContain("Run tests")
  })
})
