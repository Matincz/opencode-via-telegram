export function buildModelPickerMessage(allowedModels: string[], currentModel: string, persistedModel?: string) {
  const lines = [
    "<b>可用模型</b>",
    `当前：<code>${currentModel}</code>`,
    `原生默认：<code>${persistedModel || "Gemini CLI 自己的默认值"}</code>`,
    "",
    "点按钮会临时切换当前 Telegram 会话。",
    "要映射 Gemini CLI 原生持久化语义，请发送：",
    "<code>/model set gemini-3.1-pro-preview --persist</code>",
  ]

  const rows = [
    [{
      text: persistedModel && currentModel === persistedModel ? "✅ 使用原生默认" : "↺ 使用原生默认",
      callback_data: "model:__native_default__",
    }],
    ...allowedModels.map((model) => [{
      text: model === currentModel ? `✅ ${model}` : model,
      callback_data: `model:${model}`,
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
