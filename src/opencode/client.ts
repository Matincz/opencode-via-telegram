import type { FilePartInput, PromptPartInput } from "./parts"

export interface ModelRef {
  providerID: string
  modelID: string
}

async function assertOk(response: Response, action: string) {
  if (response.ok) return
  const body = await response.text().catch(() => "")
  throw new Error(`${action}失败 (${response.status})${body ? `: ${body}` : ""}`)
}

export async function sendSessionPromptAsync(input: {
  baseUrl: string
  sessionId: string
  model?: ModelRef
  parts: PromptPartInput[]
}) {
  const response = await fetch(`${input.baseUrl}/session/${input.sessionId}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: input.model,
      parts: input.parts,
    }),
  })
  await assertOk(response, "发送消息到 OpenCode")
}

export async function sendSessionCommand(input: {
  baseUrl: string
  sessionId: string
  model?: ModelRef
  command: string
  arguments: string
  parts?: FilePartInput[]
}) {
  const response = await fetch(`${input.baseUrl}/session/${input.sessionId}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: input.model ? `${input.model.providerID}/${input.model.modelID}` : undefined,
      command: input.command,
      arguments: input.arguments,
      parts: input.parts,
    }),
  })
  await assertOk(response, "执行命令")
  return response.json()
}
