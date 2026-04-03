import { spawn } from "child_process"

export interface CronToolResult {
  code: number
  stdout: string
  stderr: string
  json?: any
}

export function tokenizeCronArgs(raw: string) {
  const tokens: string[] = []
  let current = ""
  let quote: "'" | '"' | null = null
  let escaped = false

  for (const char of raw) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }

    if (char === "\\") {
      escaped = true
      continue
    }

    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }

    if (char === "'" || char === '"') {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }

    current += char
  }

  if (current) {
    tokens.push(current)
  }

  return tokens
}

export function parseCronOptionArgs(tokens: string[]) {
  const values = new Map<string, string>()
  const flags = new Set<string>()

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith("--")) continue

    const next = tokens[index + 1]
    if (!next || next.startsWith("--")) {
      flags.add(token)
      continue
    }

    values.set(token, next)
    index += 1
  }

  return { values, flags }
}
