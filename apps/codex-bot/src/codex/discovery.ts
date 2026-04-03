import { spawn } from "child_process"

export interface CodexModelInfo {
  id: string
  displayName: string
  description: string
  supportedEfforts: string[]
  defaultEffort: string
  isDefault: boolean
}

export const FALLBACK_CODEX_MODELS: CodexModelInfo[] = [
  {
    id: "gpt-5.4",
    displayName: "gpt-5.4",
    description: "Latest frontier agentic coding model.",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    isDefault: true,
  },
  {
    id: "gpt-5.4-mini",
    displayName: "GPT-5.4-Mini",
    description: "Smaller frontier agentic coding model.",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    isDefault: false,
  },
  {
    id: "gpt-5.3-codex",
    displayName: "gpt-5.3-codex",
    description: "Frontier Codex-optimized agentic coding model.",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    isDefault: false,
  },
  {
    id: "gpt-5.2-codex",
    displayName: "gpt-5.2-codex",
    description: "Frontier agentic coding model.",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    isDefault: false,
  },
]

function parseDiscoveredModels(raw: string) {
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let payload: any
    try {
      payload = JSON.parse(trimmed)
    } catch {
      continue
    }

    if (payload?.id !== 2) continue
    const rows = Array.isArray(payload?.result?.data) ? payload.result.data : []
    return rows
      .filter((row: any) => row && typeof row.id === "string")
      .map((row: any) => ({
        id: String(row.id),
        displayName: String(row.displayName || row.id),
        description: String(row.description || ""),
        supportedEfforts: Array.isArray(row.supportedReasoningEfforts)
          ? row.supportedReasoningEfforts
            .map((item: any) => String(item?.reasoningEffort || "").trim())
            .filter(Boolean)
          : ["medium"],
        defaultEffort: String(row.defaultReasoningEffort || "medium"),
        isDefault: row.isDefault === true,
      })) satisfies CodexModelInfo[]
  }

  return []
}

export async function discoverCodexModels(input: {
  codexBin?: string
  timeoutMs?: number
} = {}) {
  const codexBin = input.codexBin || process.env.CODEX_BIN || "codex"
  const timeoutMs = Math.max(1000, input.timeoutMs || 30000)

  return await new Promise<CodexModelInfo[]>((resolve) => {
    const child = spawn(codexBin, ["app-server"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "ignore"],
    })

    let stdout = ""
    let settled = false

    const finish = (models: CodexModelInfo[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill("SIGKILL")
      resolve(models.length > 0 ? models : FALLBACK_CODEX_MODELS)
    }

    const timer = setTimeout(() => finish(FALLBACK_CODEX_MODELS), timeoutMs)

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      const parsed = parseDiscoveredModels(stdout)
      if (parsed.length > 0) {
        finish(parsed)
      }
    })

    child.on("error", () => finish(FALLBACK_CODEX_MODELS))
    child.on("close", () => finish(parseDiscoveredModels(stdout)))

    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: { clientInfo: { name: "agents-via-telegram", version: "1.0" } },
    }) + "\n")
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "model/list",
      id: 2,
      params: {},
    }) + "\n")
  })
}
