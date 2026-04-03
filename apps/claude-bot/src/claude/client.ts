import { spawn } from "child_process"
import * as path from "path"

export type ClaudePermissionMode =
  | "bypassPermissions"
  | "acceptEdits"
  | "default"
  | "plan"

export interface ClaudeRunOptions {
  prompt: string
  model?: string
  resume?: string
  cwd?: string
  claudeBin?: string
  effort?: string
  images?: string[]
  addDirectories?: string[]
  permissionMode?: ClaudePermissionMode
  maxTurns?: number
  timeoutMs?: number
  signal?: AbortSignal
  onEvent?: (event: ClaudeStreamEvent) => void
  onSpawn?: (handle: ClaudeProcessHandle) => void
}

export interface ClaudeProcessHandle {
  pid?: number
  interrupt: () => void
  terminate: () => void
}

export interface ClaudeRunResult {
  sessionId?: string
  text: string
  costUSD?: number
}

export interface ClaudeStreamState {
  sessionId?: string
  text: string
  costUSD?: number
}

export type ClaudeStreamEvent =
  | { type: "init"; sessionId?: string; raw: Record<string, unknown> }
  | { type: "text_delta"; content: string; raw: Record<string, unknown> }
  | { type: "message"; content: string; raw: Record<string, unknown> }
  | { type: "tool_use"; toolName: string; toolInput?: Record<string, unknown>; raw: Record<string, unknown> }
  | { type: "tool_progress"; toolName?: string; summary?: string; raw: Record<string, unknown> }
  | { type: "tool_result"; toolName?: string; raw: Record<string, unknown> }
  | { type: "result"; resultText: string; costUSD?: number; raw: Record<string, unknown> }
  | { type: "error"; message: string; raw: Record<string, unknown> }
  | { type: "task_started"; taskId: string; description: string; raw: Record<string, unknown> }
  | { type: "task_progress"; taskId: string; summary?: string; raw: Record<string, unknown> }
  | { type: "task_completed"; taskId: string; summary: string; raw: Record<string, unknown> }
  | { type: "unknown"; eventType: string; raw: Record<string, unknown> }

export interface ClaudeStreamLineResult {
  state: ClaudeStreamState
  event?: ClaudeStreamEvent
}

export class ClaudeCliError extends Error {
  sessionId?: string
  partialText?: string

  constructor(message: string, input: { sessionId?: string; partialText?: string } = {}) {
    super(message)
    this.name = "ClaudeCliError"
    this.sessionId = input.sessionId
    this.partialText = input.partialText
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function getString(payload: Record<string, unknown>, key: string) {
  const value = payload[key]
  return typeof value === "string" && value.trim() ? value : undefined
}

function getNumber(payload: Record<string, unknown>, key: string) {
  const value = payload[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function dedupeDirectories(directories: string[]) {
  return [...new Set(directories.map((entry) => path.resolve(entry)))]
}

function extractMessageContent(payload: Record<string, unknown>) {
  const message = asRecord(payload.message)
  const content = asArray(message.content)
  return content.map((item) => asRecord(item))
}

function extractAssistantText(content: Record<string, unknown>[]) {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("")
}

function extractToolName(payload: Record<string, unknown>) {
  return (
    getString(payload, "name")
    || getString(payload, "tool_name")
    || getString(payload, "tool")
    || getString(payload, "id")
  )
}

export function buildClaudeArgs(options: ClaudeRunOptions): string[] {
  const prompt = options.prompt.trim()
  const addDirectories = dedupeDirectories(options.addDirectories || [])
  const args = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
  ]

  if (options.permissionMode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions")
  } else if (options.permissionMode && options.permissionMode !== "default") {
    args.push("--permission-mode", options.permissionMode)
  }

  if (options.model) {
    args.push("--model", options.model)
  }

  if (options.effort) {
    args.push("--effort", options.effort)
  }

  if (options.resume) {
    args.push("--resume", options.resume)
  }

  if (options.maxTurns && Number.isFinite(options.maxTurns) && options.maxTurns > 0) {
    args.push("--max-turns", String(options.maxTurns))
  }

  for (const directory of addDirectories) {
    args.push("--add-dir", directory)
  }

  args.push("--", prompt)
  return args
}

export function parseClaudeStreamEvent(payload: Record<string, unknown>): ClaudeStreamEvent {
  const type = String(payload.type || "unknown").trim()

  if (type === "assistant" || type === "partial_assistant") {
    const content = extractMessageContent(payload)
    const fullText = extractAssistantText(content)

    if (type === "partial_assistant" && fullText) {
      return { type: "text_delta", content: fullText, raw: payload }
    }

    if (type === "assistant" && fullText) {
      return { type: "message", content: fullText, raw: payload }
    }

    const toolUse = content.find((block) => block.type === "tool_use")
    if (toolUse) {
      return {
        type: "tool_use",
        toolName: String(toolUse.name || "unknown"),
        toolInput: asRecord(toolUse.input),
        raw: payload,
      }
    }

    return { type: "unknown", eventType: type, raw: payload }
  }

  if (type === "result") {
    const subtype = String(payload.subtype || "")
    if (subtype === "success") {
      return {
        type: "result",
        resultText: String(payload.result || ""),
        costUSD: getNumber(payload, "cost_usd"),
        raw: payload,
      }
    }

    return {
      type: "error",
      message: subtype === "error_max_turns"
        ? "超过最大轮次限制"
        : String(payload.result || payload.error || "执行出错"),
      raw: payload,
    }
  }

  if (type === "system") {
    const subtype = String(payload.subtype || "")
    if (subtype === "task_started") {
      return {
        type: "task_started",
        taskId: String(payload.task_id || ""),
        description: String(payload.description || ""),
        raw: payload,
      }
    }
    if (subtype === "task_progress") {
      return {
        type: "task_progress",
        taskId: String(payload.task_id || ""),
        summary: getString(payload, "summary"),
        raw: payload,
      }
    }
    if (subtype === "task_notification") {
      return {
        type: "task_completed",
        taskId: String(payload.task_id || ""),
        summary: String(payload.summary || ""),
        raw: payload,
      }
    }
    return { type: "unknown", eventType: `system:${subtype}`, raw: payload }
  }

  if (type === "tool_use") {
    return {
      type: "tool_use",
      toolName: extractToolName(payload) || "unknown",
      toolInput: asRecord(payload.input),
      raw: payload,
    }
  }

  if (type === "tool_progress") {
    return {
      type: "tool_progress",
      toolName: extractToolName(payload),
      summary: getString(payload, "summary") || getString(payload, "message"),
      raw: payload,
    }
  }

  if (type === "tool_result" || type === "tool_use_summary") {
    return {
      type: "tool_result",
      toolName: extractToolName(payload),
      raw: payload,
    }
  }

  return { type: "unknown", eventType: type, raw: payload }
}

export function applyClaudeStreamLine(state: ClaudeStreamState, line: string): ClaudeStreamLineResult {
  const trimmed = line.trim()
  if (!trimmed) return { state }

  const payload = asRecord(JSON.parse(trimmed))
  const sessionId = getString(payload, "session_id") || state.sessionId
  const event = parseClaudeStreamEvent(payload)

  if (event.type === "message" || event.type === "text_delta") {
    return {
      state: {
        ...state,
        sessionId,
        text: event.content,
      },
      event,
    }
  }

  if (event.type === "result") {
    return {
      state: {
        ...state,
        sessionId,
        text: event.resultText || state.text,
        costUSD: event.costUSD ?? state.costUSD,
      },
      event,
    }
  }

  return {
    state: {
      ...state,
      sessionId,
    },
    event,
  }
}

function summarizeStderr(stderr: string) {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
}

export async function runClaudePrompt(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const claudeBin = options.claudeBin || process.env.CLAUDE_BIN || "claude"
  const cwd = options.cwd || process.cwd()
  const timeoutMs = Math.max(1000, options.timeoutMs || Number(process.env.CLAUDE_TIMEOUT_MS || 600000))
  const args = buildClaudeArgs(options)

  return await new Promise<ClaudeRunResult>((resolve, reject) => {
    const child = spawn(claudeBin, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })

    options.onSpawn?.({
      pid: child.pid,
      interrupt: () => child.kill("SIGINT"),
      terminate: () => child.kill("SIGTERM"),
    })

    let stdoutBuffer = ""
    let stderr = ""
    let settled = false
    let state: ClaudeStreamState = { text: "" }
    let streamErrorMessage: string | undefined
    let sawSuccessResult = false

    const finish = (handler: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abortHandler)
      handler()
    }

    const emitSessionInit = (sessionId?: string) => {
      if (!sessionId || sessionId === state.sessionId) return
      state = { ...state, sessionId }
      options.onEvent?.({
        type: "init",
        sessionId,
        raw: { session_id: sessionId },
      })
    }

    const handleLine = (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return

      const payload = asRecord(JSON.parse(trimmed))
      const sessionId = getString(payload, "session_id")
      emitSessionInit(sessionId)

      const result = applyClaudeStreamLine(state, trimmed)
      state = result.state

      if (result.event?.type === "result") {
        sawSuccessResult = true
      }

      if (result.event?.type === "error") {
        streamErrorMessage = result.event.message
      }

      if (result.event) {
        options.onEvent?.(result.event)
      }
    }

    const abortHandler = () => {
      child.kill("SIGTERM")
      finish(() => reject(new ClaudeCliError("Claude 请求已取消", {
        sessionId: state.sessionId,
        partialText: state.text || undefined,
      })))
    }

    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      finish(() => reject(new ClaudeCliError(`Claude CLI 请求超时（${timeoutMs}ms）`, {
        sessionId: state.sessionId,
        partialText: state.text || undefined,
      })))
    }, timeoutMs)

    options.signal?.addEventListener("abort", abortHandler, { once: true })

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk

      while (stdoutBuffer.includes("\n")) {
        const newlineIndex = stdoutBuffer.indexOf("\n")
        const line = stdoutBuffer.slice(0, newlineIndex)
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)

        try {
          handleLine(line)
        } catch (error) {
          stderr += `\n[parse-error] ${error instanceof Error ? error.message : String(error)}`
        }
      }
    })

    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })

    child.on("error", (error) => {
      finish(() => reject(new ClaudeCliError(error.message, {
        sessionId: state.sessionId,
        partialText: state.text || undefined,
      })))
    })

    child.on("close", (code) => {
      finish(() => {
        if (stdoutBuffer.trim()) {
          try {
            handleLine(stdoutBuffer)
          } catch (error) {
            stderr += `\n[parse-error] ${error instanceof Error ? error.message : String(error)}`
          }
        }

        if (code !== 0 || (!sawSuccessResult && streamErrorMessage)) {
          const detail = streamErrorMessage || summarizeStderr(stderr) || state.text || "Claude CLI 未返回更多错误信息。"
          reject(new ClaudeCliError(detail, {
            sessionId: state.sessionId,
            partialText: state.text || undefined,
          }))
          return
        }

        resolve({
          sessionId: state.sessionId,
          text: state.text.trim(),
          costUSD: state.costUSD,
        })
      })
    })
  })
}
