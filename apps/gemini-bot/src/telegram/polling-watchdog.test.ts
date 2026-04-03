import { describe, expect, it } from "bun:test"
import { getPollingRecoveryReason } from "./polling-watchdog"

describe("getPollingRecoveryReason", () => {
  it("restarts when polling is no longer active", () => {
    expect(getPollingRecoveryReason({
      isPolling: false,
      pendingUpdateCount: 0,
      lastInboundAt: 1000,
      now: 2000,
      stalledPendingThresholdMs: 30000,
    })).toBe("polling stopped")
  })

  it("restarts when pending updates have been stuck for too long", () => {
    expect(getPollingRecoveryReason({
      isPolling: true,
      pendingUpdateCount: 2,
      lastInboundAt: 1_000,
      now: 40_000,
      stalledPendingThresholdMs: 30_000,
    })).toBe("pending updates stuck (2)")
  })

  it("does not restart when polling is active and updates are fresh", () => {
    expect(getPollingRecoveryReason({
      isPolling: true,
      pendingUpdateCount: 1,
      lastInboundAt: 25_000,
      now: 40_000,
      stalledPendingThresholdMs: 30_000,
    })).toBeUndefined()
  })

  it("does not restart when an update is actively being handled", () => {
    expect(getPollingRecoveryReason({
      isPolling: true,
      pendingUpdateCount: 1,
      lastInboundAt: 1_000,
      now: 40_000,
      stalledPendingThresholdMs: 30_000,
      isBusy: true,
    })).toBeUndefined()
  })
})
