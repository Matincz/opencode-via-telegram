import type { CodexModelInfo } from "../codex/discovery"

export function buildCodexModelPickerMessage(input: {
  allowedModels: string[]
  currentModel: string
  currentEffort: string
  defaultModel?: string
}) {
  const lines = [
    "<b>可用 Codex 模型</b>",
    `当前：<code>${input.currentModel}</code>`,
    `推理强度：<code>${input.currentEffort}</code>`,
    `默认：<code>${input.defaultModel || "Codex CLI 默认值"}</code>`,
    "",
    "点按钮会切换当前 Telegram 会话使用的模型。",
  ]

  const rows = [
    [{
      text: input.defaultModel && input.currentModel === input.defaultModel ? "✅ 使用默认模型" : "↺ 使用默认模型",
      callback_data: "codex-model:__default__",
    }],
    ...input.allowedModels.map((model) => [{
      text: model === input.currentModel ? `✅ ${model}` : model,
      callback_data: `codex-model:${model}`,
    }]),
  ]

  return {
    text: lines.join("\n"),
    options: {
      parse_mode: "HTML" as const,
      reply_markup: {
        inline_keyboard: rows,
      },
    },
  }
}

export function buildCodexEffortPickerMessage(input: {
  model: CodexModelInfo
  currentEffort: string
  fallbackEffort: string
}) {
  const lines = [
    "<b>Codex 推理强度</b>",
    `模型：<code>${input.model.id}</code>`,
    `当前：<code>${input.currentEffort}</code>`,
    `默认：<code>${input.model.defaultEffort || input.fallbackEffort}</code>`,
    "",
    "点按钮会切换当前 Telegram 会话使用的 reasoning effort。",
  ]

  const rows = [
    [{
      text:
        input.currentEffort === input.model.defaultEffort
          ? `✅ 使用模型默认 (${input.model.defaultEffort})`
          : `↺ 使用模型默认 (${input.model.defaultEffort})`,
      callback_data: "codex-effort:__default__",
    }],
    ...input.model.supportedEfforts.map((effort) => [{
      text: effort === input.currentEffort ? `✅ ${effort}` : effort,
      callback_data: `codex-effort:${effort}`,
    }]),
  ]

  return {
    text: lines.join("\n"),
    options: {
      parse_mode: "HTML" as const,
      reply_markup: {
        inline_keyboard: rows,
      },
    },
  }
}
