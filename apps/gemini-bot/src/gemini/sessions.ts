import { spawn } from "child_process"

export interface GeminiCliSessionInfo {
  index: number
  summary: string
  relativeTime: string
  sessionId: string
}

export function parseGeminiSessionsOutput(output: string) {
  const sessions: GeminiCliSessionInfo[] = []

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim()
    const match = /^(\d+)\.\s+(.+)\s+\(([^()]+)\)\s+\[([0-9a-f-]+)\]$/i.exec(line)
    if (!match) continue

    sessions.push({
      index: Number(match[1]),
      summary: match[2]!.trim(),
      relativeTime: match[3]!.trim(),
      sessionId: match[4]!.trim(),
    })
  }

  return sessions
}

function runGeminiCommand(args: string[], geminiBin: string, cwd: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(geminiBin, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk)
    })

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk)
    })

    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `Gemini CLI 退出码异常: ${code}`))
        return
      }

      resolve([stdout, stderr].filter(Boolean).join("\n").trim())
    })
  })
}

export async function listGeminiSessions(input: { geminiBin: string; cwd?: string }) {
  const output = await runGeminiCommand(["--list-sessions"], input.geminiBin, input.cwd || process.cwd())
  return parseGeminiSessionsOutput(output)
}

export function resolveGeminiSessionIdentifier(sessions: GeminiCliSessionInfo[], identifier: string) {
  const trimmed = identifier.trim()
  if (!trimmed) return null

  if (trimmed === "latest") {
    return sessions.at(-1) ?? null
  }

  const byId = sessions.find((session) => session.sessionId === trimmed)
  if (byId) return byId

  const index = Number(trimmed)
  if (Number.isInteger(index)) {
    return sessions.find((session) => session.index === index) ?? null
  }

  return null
}

export async function deleteGeminiSession(input: { geminiBin: string; identifier: string; cwd?: string }) {
  return await runGeminiCommand(["--delete-session", input.identifier], input.geminiBin, input.cwd || process.cwd())
}
