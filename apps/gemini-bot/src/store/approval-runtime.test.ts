import { describe, expect, test } from "bun:test"
import { clearApprovalRuntimeConfig, resolveApprovalRuntimeConfig, setApprovalRuntimeConfig } from "./approval-runtime"

describe("approval-runtime", () => {
  test("resolves defaults when no override exists", () => {
    const resolved = resolveApprovalRuntimeConfig(100, {
      strategy: "plan_then_execute",
      executionMode: "yolo",
      sandbox: true,
    })

    expect(resolved.strategy).toBe("plan_then_execute")
    expect(resolved.executionMode).toBe("yolo")
    expect(resolved.sandbox).toBe(true)
  })

  test("applies per-chat overrides", () => {
    setApprovalRuntimeConfig(200, {
      strategy: "notify",
      executionMode: "default",
      sandbox: false,
    })

    const resolved = resolveApprovalRuntimeConfig(200, {
      strategy: "plan_then_execute",
      executionMode: "yolo",
      sandbox: true,
    })

    expect(resolved.strategy).toBe("notify")
    expect(resolved.executionMode).toBe("default")
    expect(resolved.sandbox).toBe(false)

    clearApprovalRuntimeConfig(200)
  })
})
