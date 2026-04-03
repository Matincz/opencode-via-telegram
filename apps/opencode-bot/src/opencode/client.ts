import type { FilePartInput, PromptPartInput } from "./parts"
import { fetchOpencodePath } from "./backend"

export interface ModelRef {
  providerID: string
  modelID: string
}

async function assertOk(response: Response, action: string) {
  if (response.ok) return
  const body = await response.text().catch(() => "")
  throw new Error(`${action}失败 (${response.status})${body ? `: ${body}` : ""}`)
}

const OPENCODE_REQUEST_TIMEOUT_MS = Number(process.env.OPENCODE_REQUEST_TIMEOUT_MS || "8000")

async function fetchDirect(url: string, init: RequestInit) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OPENCODE_REQUEST_TIMEOUT_MS)

  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error(`请求 OpenCode 超时 (${OPENCODE_REQUEST_TIMEOUT_MS}ms)`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function fetchOpencode(input: { baseUrl?: string; path: string; init: RequestInit }) {
  if (input.baseUrl) {
    return fetchDirect(`${input.baseUrl}${input.path}`, input.init)
  }
  return fetchOpencodePath(input.path, input.init)
}

export async function sendSessionPromptAsync(input: {
  baseUrl?: string
  sessionId: string
  model?: ModelRef
  agent?: string
  parts: PromptPartInput[]
  headers?: HeadersInit
}) {
  const response = await fetchOpencode({
    baseUrl: input.baseUrl,
    path: `/session/${input.sessionId}/prompt_async`,
    init: {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(input.headers || {}) },
    body: JSON.stringify({
      model: input.model,
      agent: input.agent,
      parts: input.parts,
    }),
    },
  })
  await assertOk(response, "发送消息到 OpenCode")
}

export async function sendSessionCommand(input: {
  baseUrl?: string
  sessionId: string
  model?: ModelRef
  agent?: string
  command: string
  arguments: string
  parts?: FilePartInput[]
  headers?: HeadersInit
}) {
  const response = await fetchOpencode({
    baseUrl: input.baseUrl,
    path: `/session/${input.sessionId}/command`,
    init: {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(input.headers || {}) },
    body: JSON.stringify({
      agent: input.agent,
      model: input.model ? `${input.model.providerID}/${input.model.modelID}` : undefined,
      command: input.command,
      arguments: input.arguments,
      parts: input.parts,
    }),
    },
  })
  await assertOk(response, "执行命令")
  return response.json()
}
