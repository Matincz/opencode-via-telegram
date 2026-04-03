export const EFFORT_LEVELS = ["low", "medium", "high", "max"] as const

export type EffortLevel = (typeof EFFORT_LEVELS)[number]

export interface ClaudeModelInfo {
  id: string
  label: string
  isDefault?: boolean
}

const DEFAULT_CLAUDE_MODELS: ClaudeModelInfo[] = [
  { id: "sonnet", label: "Claude Sonnet (latest)", isDefault: true },
  { id: "opus", label: "Claude Opus (latest)" },
  { id: "haiku", label: "Claude Haiku (latest)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-opus-4", label: "Claude Opus 4" },
]

function formatModelLabel(modelId: string) {
  if (/^gpt-/i.test(modelId)) return `${modelId} (via proxy)`
  return modelId
}

function loadConfiguredModels() {
  const configured = String(process.env.CLAUDE_MODEL_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)

  if (configured.length === 0) {
    return DEFAULT_CLAUDE_MODELS
  }

  const defaultModel = String(process.env.CLAUDE_DEFAULT_MODEL || configured[0] || "").trim()
  return configured.map((id, index) => ({
    id,
    label: formatModelLabel(id),
    isDefault: id === defaultModel || (!defaultModel && index === 0),
  }))
}

export const CLAUDE_MODELS: ClaudeModelInfo[] = loadConfiguredModels()

export function getDefaultClaudeModel() {
  return CLAUDE_MODELS.find((model) => model.isDefault) || CLAUDE_MODELS[0]!
}

export function getClaudeModelInfo(modelId: string) {
  return CLAUDE_MODELS.find((model) => model.id === modelId)
}

export function isClaudeModelId(modelId: string) {
  return Boolean(getClaudeModelInfo(modelId))
}
