import { CLAUDE_MODELS, EFFORT_LEVELS } from "../claude/models"

export function buildClaudeModelPickerMessage(input: {
  currentModel: string
  currentEffort: string
  defaultModel?: string
}) {
  const lines = [
    "<b>可用 Claude 模型</b>",
    `当前：<code>${input.currentModel}</code>`,
    `推理强度：<code>${input.currentEffort}</code>`,
    `默认：<code>${input.defaultModel || "sonnet"}</code>`,
    "",
    "点按钮会切换当前 Telegram 会话使用的模型。",
  ]

  const rows = [
    [{
      text: input.defaultModel && input.currentModel === input.defaultModel ? "✅ 使用默认模型" : "↺ 使用默认模型",
      callback_data: "claude-model:__default__",
    }],
    ...CLAUDE_MODELS.map((model) => [{
      text: model.id === input.currentModel ? `✅ ${model.id}` : model.id,
      callback_data: `claude-model:${model.id}`,
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

export function buildClaudeEffortPickerMessage(input: {
  modelId: string
  currentEffort: string
  fallbackEffort: string
}) {
  const lines = [
    "<b>Claude 推理强度</b>",
    `模型：<code>${input.modelId}</code>`,
    `当前：<code>${input.currentEffort}</code>`,
    `默认：<code>${input.fallbackEffort}</code>`,
    "",
    "点按钮会切换当前 Telegram 会话使用的 effort。",
  ]

  const rows = [
    [{
      text: input.currentEffort === input.fallbackEffort ? `✅ 使用默认 (${input.fallbackEffort})` : `↺ 使用默认 (${input.fallbackEffort})`,
      callback_data: "claude-effort:__default__",
    }],
    ...EFFORT_LEVELS.map((effort) => [{
      text: effort === input.currentEffort ? `✅ ${effort}` : effort,
      callback_data: `claude-effort:${effort}`,
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
