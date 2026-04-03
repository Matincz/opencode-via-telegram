import * as fs from "fs"
import * as path from "path"
import util from "util"

type LogLevel = "debug" | "info" | "warn" | "error"
type LogContext = Record<string, unknown>

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

let installed = false

function normalizeLevel(input?: string): LogLevel {
  const value = String(input || "info").toLowerCase()
  if (value === "debug" || value === "info" || value === "warn" || value === "error") return value
  return "info"
}

function renderArg(value: unknown): string {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
  if (typeof value === "string") return value
  return util.inspect(value, {
    colors: false,
    depth: 6,
    breakLength: 120,
    compact: false,
  })
}

function renderContextValue(value: unknown): string {
  if (typeof value === "string") {
    return /\s/.test(value) ? JSON.stringify(value) : value
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }

  if (value === null) return "null"
  if (value === undefined) return "undefined"
  return JSON.stringify(value)
}

export function formatLogContext(context: LogContext = {}): string {
  return Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${renderContextValue(value)}`)
    .join(" ")
}

export function parseStackFrameLine(line: string): string | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined

  const parenMatch = trimmed.match(/\((.+:\d+:\d+)\)$/)
  if (parenMatch) return parenMatch[1]

  const plainMatch = trimmed.match(/at (.+:\d+:\d+)$/)
  if (plainMatch) return plainMatch[1]

  return undefined
}

function extractCallerLocation(stack: string | undefined, rootDir: string): string | undefined {
  if (!stack) return undefined

  const lines = stack.split("\n").slice(1)
  for (const line of lines) {
    const frame = parseStackFrameLine(line)
    if (!frame) continue
    if (frame.includes("/src/runtime/logger.ts")) continue
    if (frame.includes("node:internal")) continue

    return path.relative(rootDir, frame)
  }

  return undefined
}

interface InstallLoggerOptions {
  rootDir: string
  level?: string
}

export function installGlobalLogger(options: InstallLoggerOptions) {
  const logsDir = path.join(options.rootDir, "logs")
  const combinedLogPath = path.join(logsDir, "bridge.log")
  const errorLogPath = path.join(logsDir, "error.log")

  if (installed) {
    return { logsDir, combinedLogPath, errorLogPath }
  }

  installed = true

  const minimumLevel = normalizeLevel(options.level)

  fs.mkdirSync(logsDir, { recursive: true })

  const combinedStream = fs.createWriteStream(combinedLogPath, { flags: "a" })
  const errorStream = fs.createWriteStream(errorLogPath, { flags: "a" })

  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  }

  function write(level: LogLevel, args: unknown[]) {
    if (LEVEL_RANK[level] < LEVEL_RANK[minimumLevel]) return

    const stack = new Error().stack
    const location = extractCallerLocation(stack, options.rootDir)
    const message = args.map(renderArg).join(" ")
    const timestamp = new Date().toISOString()
    const prefix = `${timestamp} ${level.toUpperCase()}`
    const line = location ? `${prefix} [${location}] ${message}` : `${prefix} ${message}`

    combinedStream.write(`${line}\n`)
    if (level === "warn" || level === "error") {
      errorStream.write(`${line}\n`)
    }

    if (level === "warn") {
      original.warn(line)
      return
    }

    if (level === "error") {
      original.error(line)
      return
    }

    original.log(line)
  }

  console.log = (...args: unknown[]) => write("info", args)
  console.info = (...args: unknown[]) => write("info", args)
  console.warn = (...args: unknown[]) => write("warn", args)
  console.error = (...args: unknown[]) => write("error", args)

  process.on("uncaughtException", (error) => {
    write("error", ["[UNCAUGHT_EXCEPTION]", error])
  })

  process.on("unhandledRejection", (reason) => {
    write("error", ["[UNHANDLED_REJECTION]", reason])
  })

  process.on("exit", () => {
    combinedStream.end()
    errorStream.end()
  })

  return { logsDir, combinedLogPath, errorLogPath }
}

function logWithEvent(level: "info" | "warn" | "error", event: string, context: LogContext = {}, ...args: unknown[]) {
  const prefix = `[${event}]`
  const contextText = formatLogContext(context)
  const parts = [prefix]
  if (contextText) parts.push(contextText)
  if (args.length) parts.push(...args.map(renderArg))

  if (level === "warn") {
    console.warn(parts.join(" "))
    return
  }

  if (level === "error") {
    console.error(parts.join(" "))
    return
  }

  console.log(parts.join(" "))
}

export function logInfo(event: string, context: LogContext = {}, ...args: unknown[]) {
  logWithEvent("info", event, context, ...args)
}

export function logWarn(event: string, context: LogContext = {}, ...args: unknown[]) {
  logWithEvent("warn", event, context, ...args)
}

export function logError(event: string, context: LogContext = {}, ...args: unknown[]) {
  logWithEvent("error", event, context, ...args)
}
