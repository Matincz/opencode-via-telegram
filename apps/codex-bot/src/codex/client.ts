import { spawn } from "child_process"
import * as path from "path"

export type CodexPermissionMode =
  | "bypassPermissions"
  | "workspace-write"
  | "danger-full-access"
  | "read-only"

export interface CodexRunOptions {
  prompt: string
  model?: string
  resume?: string
  cwd?: string
  codexBin?: string
  reasoningEffort?: string
  images?: string[]
  addDirectories?: string[]
  permissionMode?: CodexPermissionMode
  timeoutMs?: number
  signal?: AbortSignal
  onEvent?: (event: CodexStreamEvent) => void
  onSpawn?: (handle: CodexProcessHandle) => void
}

export interface CodexProcessHandle {
  pid?: number
  interrupt: () => void
  terminate: () => void
}

export interface CodexRunResult {
  sessionId?: string
  text: string
  usage?: Record<string, unknown>
}

export interface CodexStreamState {
  sessionId?: string
  text: string
  usage?: Record<string, unknown>
}

interface CodexStreamEventBase {
  type: string
  raw: Record<string, unknown>
}

export interface CodexStreamInitEvent extends CodexStreamEventBase {
  type: "init"
  sessionId?: string
}

export interface CodexStreamMessageEvent extends CodexStreamEventBase {
  type: "message"
  content?: string
}

export interface CodexStreamReasoningEvent extends CodexStreamEventBase {
  type: "reasoning"
  content?: string
}

export interface CodexStreamToolUseEvent extends CodexStreamEventBase {
  type: "tool_use"
  toolName?: string
}

export interface CodexStreamResultEvent extends CodexStreamEventBase {
  type: "result"
  usage?: Record<string, unknown>
}

export interface CodexStreamErrorEvent extends CodexStreamEventBase {
  type: "error"
  message?: string
}

export interface CodexStreamUnknownEvent extends CodexStreamEventBase {
  type: "unknown"
  eventType?: string
}

export type CodexStreamEvent =
  | CodexStreamInitEvent
  | CodexStreamMessageEvent
  | CodexStreamReasoningEvent
  | CodexStreamToolUseEvent
  | CodexStreamResultEvent
  | CodexStreamErrorEvent
  | CodexStreamUnknownEvent

export interface CodexStreamLineResult {
  state: CodexStreamState
  event?: CodexStreamEvent
}

export class CodexCliError extends Error {
  sessionId?: string
  partialText?: string

  constructor(message: string, input: { sessionId?: string; partialText?: string } = {}) {
    super(message)
    this.name = "CodexCliError"
    this.sessionId = input.sessionId
    this.partialText = input.partialText
  }
}

const TOOL_ITEM_TYPE_MAP: Record<string, string> = {
  command_execution: "Bash",
  file_change: "Edit",
  web_search: "WebSearch",
  todo_list: "TodoWrite",
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

function getString(payload: Record<string, unknown>, key: string) {
  const value = payload[key]
  return typeof value === "string" && value.trim() ? value : undefined
}

function buildSandboxFlags(permissionMode: CodexPermissionMode = "workspace-write") {
  if (permissionMode === "bypassPermissions") {
    return ["--dangerously-bypass-approvals-and-sandbox"]
  }

  if (permissionMode === "workspace-write") {
    return ["--full-auto"]
  }

  if (permissionMode === "danger-full-access") {
    return ["--sandbox", "danger-full-access"]
  }

  return ["--sandbox", "read-only"]
}

function dedupeDirectories(directories: string[]) {
  return [...new Set(directories.map((entry) => path.resolve(entry)))]
}

export function buildCodexArgs(options: CodexRunOptions) {
  const prompt = options.prompt.trim()
  const images = options.images || []
  const addDirectories = dedupeDirectories(options.addDirectories || [])
  const sandboxFlags = buildSandboxFlags(options.permissionMode)

  if (options.resume) {
    return [
      "exec",
      "resume",
      "--json",
      ...sandboxFlags,
      "--",
      options.resume,
      prompt,
    ]
  }

  const args = [
    "exec",
    "--json",
    "--color",
    "never",
    ...sandboxFlags,
    "--skip-git-repo-check",
  ]

  if (options.model) {
    args.push("--model", options.model)
  }

  if (options.reasoningEffort && options.reasoningEffort !== "default") {
    args.push("-c", `model_reasoning_effort=${options.reasoningEffort}`)
  }

  for (const directory of addDirectories) {
    args.push("--add-dir", directory)
  }

  for (const image of images) {
    args.push("--image", image)
  }

  args.push("--", prompt)
  return args
}

export function parseCodexStreamEvent(payload: Record<string, unknown>): CodexStreamEvent {
  const type = typeof payload.type === "string" && payload.type.trim() ? payload.type.trim() : "unknown"

  if (type === "thread.started") {
    return {
      type: "init",
      sessionId: getString(payload, "thread_id"),
      raw: payload,
    }
  }

  if (type === "turn.completed") {
    const usage = asRecord(payload.usage)
    return {
      type: "result",
      usage: Object.keys(usage).length > 0 ? usage : undefined,
      raw: payload,
    }
  }

  if (type === "turn.failed") {
    const error = asRecord(payload.error)
    return {
      type: "error",
      message: getString(error, "message"),
      raw: payload,
    }
  }

  if (type === "item.started" || type === "item.updated" || type === "item.completed") {
    const item = asRecord(payload.item)
    const itemType = getString(item, "type")

    if (itemType === "agent_message" && type === "item.completed") {
      return {
        type: "message",
        content: getString(item, "text"),
        raw: payload,
      }
    }

    if (itemType === "reasoning") {
      return {
        type: "reasoning",
        content: getString(item, "text"),
        raw: payload,
      }
    }

    if (type === "item.started" && itemType === "mcp_tool_call") {
      return {
        type: "tool_use",
        toolName: getString(item, "name") || getString(item, "tool_name") || "MCP",
        raw: payload,
      }
    }

    if (type === "item.started" && itemType && TOOL_ITEM_TYPE_MAP[itemType]) {
      return {
        type: "tool_use",
        toolName: TOOL_ITEM_TYPE_MAP[itemType],
        raw: payload,
      }
    }
  }

  return {
    type: "unknown",
    eventType: type,
    raw: payload,
  }
}

export function applyCodexStreamLine(state: CodexStreamState, line: string): CodexStreamLineResult {
  const trimmed = line.trim()
  if (!trimmed) return { state }

  const event = parseCodexStreamEvent(asRecord(JSON.parse(trimmed)))

  if (event.type === "init") {
    return {
      state: {
        ...state,
        sessionId: event.sessionId || state.sessionId,
      },
      event,
    }
  }

  if (event.type === "message" && event.content) {
    return {
      state: {
        ...state,
        text: state.text ? `${state.text}\n${event.content}` : event.content,
      },
      event,
    }
  }

  if (event.type === "result") {
    return {
      state: {
        ...state,
        usage: event.usage || state.usage,
      },
      event,
    }
  }

  return { state, event }
}

function summarizeStderr(stderr: string) {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
}

export async function runCodexPrompt(options: CodexRunOptions) {
  const codexBin = options.codexBin || process.env.CODEX_BIN || "codex"
  const cwd = options.cwd || process.cwd()
  const timeoutMs = Math.max(1000, options.timeoutMs || Number(process.env.CODEX_TIMEOUT_MS || 600000))
  const args = buildCodexArgs(options)

  return await new Promise<CodexRunResult>((resolve, reject) => {
    const child = spawn(codexBin, args, {
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
    let state: CodexStreamState = { text: "" }

    const finish = (handler: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abortHandler)
      handler()
    }

    const abortHandler = () => {
      child.kill("SIGTERM")
      finish(() => reject(new CodexCliError("Codex 请求已取消", {
        sessionId: state.sessionId,
        partialText: state.text || undefined,
      })))
    }

    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      finish(() => reject(new CodexCliError(`Codex CLI 请求超时（${timeoutMs}ms）`, {
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
          const result = applyCodexStreamLine(state, line)
          state = result.state
          if (result.event) {
            options.onEvent?.(result.event)
          }
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
      finish(() => reject(new CodexCliError(error.message, {
        sessionId: state.sessionId,
        partialText: state.text || undefined,
      })))
    })

    child.on("close", (code) => {
      finish(() => {
        if (stdoutBuffer.trim()) {
          try {
            const result = applyCodexStreamLine(state, stdoutBuffer)
            state = result.state
            if (result.event) options.onEvent?.(result.event)
          } catch (error) {
            stderr += `\n[parse-error] ${error instanceof Error ? error.message : String(error)}`
          }
        }

        if (code !== 0) {
          const detail = summarizeStderr(stderr) || state.text || "Codex CLI 未返回更多错误信息。"
          reject(new CodexCliError(detail, {
            sessionId: state.sessionId,
            partialText: state.text || undefined,
          }))
          return
        }

        resolve({
          sessionId: state.sessionId,
          text: state.text.trim(),
          usage: state.usage,
        })
      })
    })
  })
}
