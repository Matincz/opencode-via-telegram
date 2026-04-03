import { spawn } from "child_process"

export interface GeminiRunOptions {
  prompt: string
  model?: string
  resume?: string
  timeoutMs?: number
  maxAttempts?: number
  retryOnFetchErrors?: boolean
  cwd?: string
  includeDirectories?: string[]
  geminiBin?: string
  approvalMode?: string
  sandbox?: boolean | string
  onChunk?: (chunk: string) => void
  onEvent?: (event: GeminiStreamEvent) => void
  onRetry?: (input: { attempt: number; maxAttempts: number; delayMs: number; error: Error }) => void
  signal?: AbortSignal
}

export interface GeminiRunResult {
  sessionId?: string
  model?: string
  text: string
  stats?: Record<string, unknown>
  isPartial?: boolean
  timedOut?: boolean
}

export interface GeminiStreamState {
  sessionId?: string
  model?: string
  text: string
  stats?: Record<string, unknown>
}

export interface GeminiStreamEventBase {
  type: string
  raw: Record<string, unknown>
}

export interface GeminiStreamInitEvent extends GeminiStreamEventBase {
  type: "init"
  sessionId?: string
  model?: string
}

export interface GeminiStreamMessageEvent extends GeminiStreamEventBase {
  type: "message"
  role?: string
  content?: string
  delta?: boolean
}

export interface GeminiStreamToolUseEvent extends GeminiStreamEventBase {
  type: "tool_use"
  name?: string
  toolName?: string
  id?: string
  toolCallId?: string
  input?: unknown
}

export interface GeminiStreamToolResultEvent extends GeminiStreamEventBase {
  type: "tool_result"
  name?: string
  toolName?: string
  id?: string
  toolCallId?: string
  output?: unknown
  success?: boolean
}

export interface GeminiStreamErrorEvent extends GeminiStreamEventBase {
  type: "error"
  message?: string
  code?: string | number
}

export interface GeminiStreamResultEvent extends GeminiStreamEventBase {
  type: "result"
  stats?: Record<string, unknown>
}

export interface GeminiStreamUnknownEvent extends GeminiStreamEventBase {
  type: "unknown"
  eventType?: string
}

export type GeminiStreamEvent =
  | GeminiStreamInitEvent
  | GeminiStreamMessageEvent
  | GeminiStreamToolUseEvent
  | GeminiStreamToolResultEvent
  | GeminiStreamErrorEvent
  | GeminiStreamResultEvent
  | GeminiStreamUnknownEvent

export interface GeminiStreamLineResult {
  state: GeminiStreamState
  emittedText: string
  event?: GeminiStreamEvent
}

export class GeminiCliError extends Error {
  sessionId?: string
  model?: string
  partialText?: string
  timedOut: boolean

  constructor(
    message: string,
    input: {
      sessionId?: string
      model?: string
      partialText?: string
      timedOut?: boolean
    } = {},
  ) {
    super(message)
    this.name = "GeminiCliError"
    this.sessionId = input.sessionId
    this.model = input.model
    this.partialText = input.partialText
    this.timedOut = input.timedOut === true
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

function getString(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === "string" && value.trim()) {
      return value
    }
  }
  return undefined
}

function getBoolean(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === "boolean") {
      return value
    }
  }
  return undefined
}

function getUnknown(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (key in payload) {
      return payload[key]
    }
  }
  return undefined
}

function getStringOrNumber(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === "string" && value.trim()) {
      return value
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value
    }
  }
  return undefined
}

export function parseGeminiStreamEvent(payload: Record<string, unknown>): GeminiStreamEvent {
  const type = typeof payload.type === "string" && payload.type.trim() ? payload.type.trim() : "unknown"

  if (type === "init") {
    return {
      type: "init",
      sessionId: getString(payload, ["session_id", "sessionId"]),
      model: getString(payload, ["model"]),
      raw: payload,
    }
  }

  if (type === "message") {
    return {
      type: "message",
      role: getString(payload, ["role"]),
      content: getString(payload, ["content"]),
      delta: getBoolean(payload, ["delta"]),
      raw: payload,
    }
  }

  if (type === "tool_use") {
    return {
      type: "tool_use",
      name: getString(payload, ["name"]),
      toolName: getString(payload, ["tool_name", "toolName"]),
      id: getString(payload, ["id"]),
      toolCallId: getString(payload, ["tool_call_id", "toolCallId"]),
      input: getUnknown(payload, ["input", "args", "arguments"]),
      raw: payload,
    }
  }

  if (type === "tool_result") {
    return {
      type: "tool_result",
      name: getString(payload, ["name"]),
      toolName: getString(payload, ["tool_name", "toolName"]),
      id: getString(payload, ["id"]),
      toolCallId: getString(payload, ["tool_call_id", "toolCallId"]),
      output: getUnknown(payload, ["output", "content", "result"]),
      success: getBoolean(payload, ["success"]),
      raw: payload,
    }
  }

  if (type === "error") {
    return {
      type: "error",
      message: getString(payload, ["message", "error", "detail", "details"]),
      code: getStringOrNumber(payload, ["code", "status"]),
      raw: payload,
    }
  }

  if (type === "result") {
    const stats = getUnknown(payload, ["stats"])
    return {
      type: "result",
      stats: stats && typeof stats === "object" ? stats as Record<string, unknown> : undefined,
      raw: payload,
    }
  }

  return {
    type: "unknown",
    eventType: type,
    raw: payload,
  }
}

function summarizeStderr(stderr: string) {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^Loaded cached credentials\.?$/i.test(line))
    .filter((line) => !/^Skill ".+" is overriding the built-in skill\.?$/i.test(line))

  return lines.find((line) =>
    /^Error\b/i.test(line)
    || /^An unexpected critical error occurred:/i.test(line)
    || /failed, reason:/i.test(line)
    || /Invalid session identifier/i.test(line),
  ) || lines.at(-1)
}

function killGeminiProcessTree(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return

  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // Fall through to direct pid kill below.
    }
  }

  try {
    process.kill(pid, signal)
  } catch {
    // Ignore kill failures for already-exited processes.
  }
}

export function formatGeminiTimeoutMessage(timeoutMs: number, stderr: string, state: GeminiStreamState) {
  const stderrSummary = summarizeStderr(stderr)

  if (
    (!stderrSummary || /^error:\s*undefined,?$/i.test(stderrSummary))
    && state.sessionId
    && !state.text.trim()
  ) {
    const rawSuffix = stderrSummary ? `（原始 stderr: ${stderrSummary}）` : ""
    return `Gemini CLI 请求超时（${timeoutMs}ms）：Gemini CLI 已建立会话但未产出 assistant 响应，当前 OAuth headless 认证链可能卡住${rawSuffix}`
  }

  return `Gemini CLI 请求超时（${timeoutMs}ms）${stderrSummary ? `：${stderrSummary}` : ""}`
}

export function buildGeminiRunResult(
  state: GeminiStreamState,
  input: {
    isPartial?: boolean
    timedOut?: boolean
  } = {},
): GeminiRunResult {
  return {
    sessionId: state.sessionId,
    model: state.model,
    text: state.text.trim(),
    stats: state.stats,
    isPartial: input.isPartial === true,
    timedOut: input.timedOut === true,
  }
}

export function buildPartialGeminiRunResult(state: GeminiStreamState): GeminiRunResult | null {
  const result = buildGeminiRunResult(state, { isPartial: true, timedOut: true })
  return result.text ? result : null
}

function buildGeminiCliError(
  message: string,
  state: GeminiStreamState,
  input: {
    timedOut?: boolean
  } = {},
) {
  return new GeminiCliError(message, {
    sessionId: state.sessionId,
    model: state.model,
    partialText: state.text.trim() || undefined,
    timedOut: input.timedOut === true,
  })
}

export function resolveGeminiInactivityTimeoutMs(input: {
  state: GeminiStreamState
  event?: GeminiStreamEvent
  initialInactivityMs: number
  progressInactivityMs: number
}) {
  const { state, event, initialInactivityMs, progressInactivityMs } = input
  const normalizedProgressMs = Math.max(initialInactivityMs, progressInactivityMs)

  if (state.text.trim()) {
    return normalizedProgressMs
  }

  if (event?.type === "tool_use" || event?.type === "tool_result") {
    return normalizedProgressMs
  }

  return initialInactivityMs
}

function detectFatalStderr(stderr: string) {
  const summary = summarizeStderr(stderr)
  if (!summary) return null

  if (
    /Client network socket disconnected before secure TLS connection was established/i.test(stderr)
    || /request to https:\/\/cloudcode-pa\.googleapis\.com\/v1internal:loadCodeAssist failed/i.test(stderr)
    || /^An unexpected critical error occurred:/i.test(summary)
    || /Invalid session identifier/i.test(summary)
  ) {
    return summary
  }

  return null
}

export function isRetryableGeminiErrorMessage(message: string) {
  return (
    /fetch failed/i.test(message)
    || /ECONNRESET/i.test(message)
    || /ETIMEDOUT/i.test(message)
    || /EAI_AGAIN/i.test(message)
    || /ENOTFOUND/i.test(message)
    || /secure TLS connection was not established/i.test(message)
    || /loadCodeAssist failed/i.test(message)
    || /\b(429|500|502|503|504)\b/.test(message)
    || /\[timeout\] Gemini CLI exceeded/i.test(message)
    || /请求超时/i.test(message)
  )
}

export function applyGeminiStreamLine(state: GeminiStreamState, line: string): GeminiStreamLineResult {
  const trimmed = line.trim()
  if (!trimmed) return { state, emittedText: "" }

  const payload = asRecord(JSON.parse(trimmed))
  const event = parseGeminiStreamEvent(payload)

  if (event.type === "init" && typeof event.sessionId === "string") {
    return {
      state: {
        ...state,
        sessionId: event.sessionId,
        model: typeof event.model === "string" ? event.model : state.model,
      },
      emittedText: "",
      event,
    }
  }

  if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") {
    const nextText = event.delta === true ? state.text + event.content : event.content
    return {
      state: {
        ...state,
        text: nextText,
      },
      emittedText: event.delta === true ? event.content : nextText,
      event,
    }
  }

  if (event.type === "result") {
    return {
      state: {
        ...state,
        stats: event.stats,
      },
      emittedText: "",
      event,
    }
  }

  return { state, emittedText: "", event }
}

function buildGeminiArgs(options: GeminiRunOptions) {
  const args = ["-p", options.prompt, "-o", "stream-json", "-e", "none"]

  if (options.model) {
    args.push("--model", options.model)
  }

  if (options.resume) {
    args.push("--resume", options.resume)
  }

  if (options.approvalMode) {
    args.push("--approval-mode", options.approvalMode)
  }

  if (options.sandbox === true) {
    args.push("--sandbox")
  }

  for (const directory of options.includeDirectories || []) {
    args.push("--include-directories", directory)
  }

  return args
}

async function runGeminiPromptOnce(options: GeminiRunOptions) {
  const geminiBin = options.geminiBin || process.env.GEMINI_BIN || "gemini"
  const args = buildGeminiArgs(options)
  const initialInactivityMs = options.timeoutMs ?? Number(
    process.env.GEMINI_INITIAL_INACTIVITY_TIMEOUT_MS
    || process.env.GEMINI_INACTIVITY_TIMEOUT_MS
    || process.env.GEMINI_REQUEST_TIMEOUT_MS
    || 90000,
  )
  const progressInactivityMs = Math.max(
    initialInactivityMs,
    Number(process.env.GEMINI_PROGRESS_INACTIVITY_TIMEOUT_MS || process.env.GEMINI_POST_OUTPUT_INACTIVITY_TIMEOUT_MS || 300000),
  )
  const absoluteMs = Number(process.env.GEMINI_ABSOLUTE_TIMEOUT_MS || 600000)

  return await new Promise<GeminiRunResult>((resolve, reject) => {
    const childEnv = typeof options.sandbox === "string"
      ? { ...process.env, GEMINI_SANDBOX: options.sandbox }
      : options.sandbox === false
        ? { ...process.env, GEMINI_SANDBOX: "" }
        : process.env

    const child = spawn(geminiBin, args, {
      cwd: options.cwd || process.cwd(),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })

    let stderr = ""
    let buffer = ""
    let state: GeminiStreamState = {
      text: "",
    }
    let settled = false
    let timedOut = false
    let fatalError: string | null = null
    let stdoutReceived = false
    let lastStdoutTime = 0
    const startTime = Date.now()
    let currentInactivityMs = initialInactivityMs
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleForceKill = () => {
      if (forceKillTimer) clearTimeout(forceKillTimer)
      forceKillTimer = setTimeout(() => {
        killGeminiProcessTree(child.pid, "SIGKILL")
      }, 2000)
    }

    const triggerTimeout = (reason: string) => {
      timedOut = true
      const elapsed = Date.now() - startTime
      const diagParts = [`[timeout] ${reason} after ${elapsed}ms`]
      diagParts.push(`inactivity_limit=${currentInactivityMs}ms`)
      diagParts.push(`stdout_received=${stdoutReceived}`)
      diagParts.push(`session_id=${state.sessionId || "none"}`)
      diagParts.push(`has_text=${!!state.text.trim()}`)
      if (lastStdoutTime > 0) {
        diagParts.push(`last_stdout_age=${Date.now() - lastStdoutTime}ms`)
      }
      stderr += `\n${diagParts.join(", ")}`
      killGeminiProcessTree(child.pid, "SIGTERM")
      scheduleForceKill()
      const partialResult = buildPartialGeminiRunResult(state)
      if (partialResult) {
        finish(() => resolve(partialResult))
        return
      }
      finish(() => reject(buildGeminiCliError(formatGeminiTimeoutMessage(elapsed, stderr, state), state, { timedOut: true })))
    }

    let inactivityTimer = setTimeout(() => triggerTimeout("Gemini CLI inactivity timeout"), currentInactivityMs)
    const resetInactivityTimer = () => {
      clearTimeout(inactivityTimer)
      inactivityTimer = setTimeout(() => triggerTimeout("Gemini CLI inactivity timeout"), currentInactivityMs)
    }
    const updateInactivityTimeout = (event?: GeminiStreamEvent) => {
      const nextInactivityMs = resolveGeminiInactivityTimeoutMs({
        state,
        event,
        initialInactivityMs,
        progressInactivityMs,
      })
      if (nextInactivityMs === currentInactivityMs) return
      currentInactivityMs = nextInactivityMs
      resetInactivityTimer()
    }
    const absoluteTimer = setTimeout(() => triggerTimeout(`Gemini CLI absolute timeout (${absoluteMs}ms)`), absoluteMs)

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(inactivityTimer)
      clearTimeout(absoluteTimer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      fn()
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutReceived = true
      lastStdoutTime = Date.now()
      resetInactivityTimer()
      buffer += String(chunk)
      const lines = buffer.split("\n")
      buffer = lines.pop() || ""

      for (const line of lines) {
        try {
          const result = applyGeminiStreamLine(state, line)
          state = result.state
          updateInactivityTimeout(result.event)
          if (result.event) {
            options.onEvent?.(result.event)
          }
          if (result.emittedText) {
            options.onChunk?.(result.emittedText)
          }
        } catch (error) {
          stderr += `\n[stream-parse-error] ${error instanceof Error ? error.message : String(error)}`
        }
      }
    })

    child.stderr.on("data", (chunk: Buffer | string) => {
      resetInactivityTimer()
      stderr += String(chunk)
      const detected = detectFatalStderr(stderr)
      if (detected && !fatalError) {
        fatalError = detected
        killGeminiProcessTree(child.pid, "SIGTERM")
        scheduleForceKill()
        finish(() => reject(buildGeminiCliError(detected, state)))
      }
    })

    child.on("error", (error) => {
      finish(() => reject(error))
    })

    child.on("close", (code, signal) => {
      if (fatalError) {
        return
      }

      if (timedOut) {
        return
      }

      if (signal === "SIGTERM") {
        finish(() => reject(buildGeminiCliError("Gemini CLI 已终止", state)))
        return
      }

      if (code !== 0) {
        finish(() => reject(buildGeminiCliError(
          stderr.trim() || summarizeStderr(stderr) || `Gemini CLI 退出码异常: ${code}`,
          state,
        )))
        return
      }

      if (buffer.trim()) {
        try {
          const result = applyGeminiStreamLine(state, buffer)
          state = result.state
          updateInactivityTimeout(result.event)
          if (result.event) {
            options.onEvent?.(result.event)
          }
          if (result.emittedText) {
            options.onChunk?.(result.emittedText)
          }
        } catch (error) {
          stderr += `\n[stream-parse-error] ${error instanceof Error ? error.message : String(error)}`
        }
      }

      finish(() => resolve(buildGeminiRunResult(state)))
    })

    if (options.signal) {
      if (options.signal.aborted) {
        killGeminiProcessTree(child.pid, "SIGTERM")
        scheduleForceKill()
      } else {
        options.signal.addEventListener("abort", () => {
          killGeminiProcessTree(child.pid, "SIGTERM")
          scheduleForceKill()
        }, { once: true })
      }
    }
  })
}

export async function runGeminiPrompt(options: GeminiRunOptions) {
  const retryOnFetchErrors = options.retryOnFetchErrors ?? !/^(0|false|no)$/i.test(String(process.env.GEMINI_RETRY_FETCH_ERRORS || "true"))
  const maxAttempts = Math.max(1, Number(options.maxAttempts ?? (process.env.GEMINI_MAX_ATTEMPTS || 3)))

  let attempt = 1
  let lastError: Error | null = null

  while (attempt <= maxAttempts) {
    try {
      return await runGeminiPromptOnce(options)
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error))
      lastError = normalizedError

      if (!retryOnFetchErrors || attempt >= maxAttempts || !isRetryableGeminiErrorMessage(normalizedError.message)) {
        throw normalizedError
      }

      const delayMs = Math.min(3000, attempt * 750)
      options.onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        error: normalizedError,
      })
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      attempt += 1
    }
  }

  throw lastError || new Error("Gemini CLI 请求失败")
}
