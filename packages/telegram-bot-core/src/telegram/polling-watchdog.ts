export interface PollingRecoverySnapshot {
  isPolling: boolean
  pendingUpdateCount: number
  lastInboundAt: number
  now: number
  stalledPendingThresholdMs: number
  isBusy?: boolean
}

export function getPollingRecoveryReason(snapshot: PollingRecoverySnapshot): string | undefined {
  if (!snapshot.isPolling) return "polling stopped"

  if (snapshot.isBusy) return undefined

  if (
    snapshot.pendingUpdateCount > 0
    && snapshot.now - snapshot.lastInboundAt >= snapshot.stalledPendingThresholdMs
  ) {
    return `pending updates stuck (${snapshot.pendingUpdateCount})`
  }

  return undefined
}

interface PollingWatchdogOptions {
  bot: {
    stopPolling: (options?: any) => Promise<unknown>
    startPolling: (options?: any) => Promise<unknown>
    getWebHookInfo: () => Promise<unknown>
    isPolling: () => boolean
  }
  intervalMs: number
  stalledPendingThresholdMs: number
  getLastInboundAt: () => number
  getIsBusy?: () => boolean
  logger?: Pick<Console, "log" | "warn" | "error">
}

export function createTelegramPollingWatchdog(options: PollingWatchdogOptions) {
  const logger = options.logger || console
  let timer: ReturnType<typeof setInterval> | null = null
  let checking = false
  let restarting = false

  async function restartPolling(reason: string) {
    if (restarting) return
    restarting = true

    try {
      logger.warn(`[TG_POLL_WATCHDOG] restarting polling reason=${reason}`)
      await options.bot.stopPolling({ cancel: true, reason })
      await options.bot.startPolling({ restart: true })
      logger.log(`[TG_POLL_WATCHDOG] polling restarted reason=${reason}`)
    } catch (error) {
      logger.error(`[TG_POLL_WATCHDOG] polling restart failed reason=${reason}`, error)
    } finally {
      restarting = false
    }
  }

  async function checkHealth() {
    if (checking || restarting) return
    checking = true

    try {
      const webhookInfo: any = await options.bot.getWebHookInfo()
      const pendingUpdateCount = Number(webhookInfo?.pending_update_count || 0)
      const reason = getPollingRecoveryReason({
        isPolling: options.bot.isPolling(),
        pendingUpdateCount,
        lastInboundAt: options.getLastInboundAt(),
        now: Date.now(),
        stalledPendingThresholdMs: options.stalledPendingThresholdMs,
        isBusy: options.getIsBusy?.() ?? false,
      })

      if (reason) {
        await restartPolling(reason)
      }
    } catch (error) {
      logger.error("[TG_POLL_WATCHDOG] health check failed", error)
    } finally {
      checking = false
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => {
        void checkHealth()
      }, options.intervalMs)
    },
    stop() {
      if (!timer) return
      clearInterval(timer)
      timer = null
    },
    checkNow() {
      return checkHealth()
    },
    triggerRestart(reason: string) {
      return restartPolling(reason)
    },
  }
}
