export function buildPlanModePickerMessage(enabled: boolean) {
  return {
    text: [
      "<b>计划模式</b>",
      `当前状态：<code>${enabled ? "on" : "off"}</code>`,
      enabled
        ? "当前 agent 请求会先生成计划，再在 Telegram 里审批。"
        : "当前请求默认直接执行，不先走计划审批。",
      "",
      "点按钮即可切换。",
    ].join("\n"),
    options: {
      parse_mode: "HTML" as const,
      reply_markup: {
        inline_keyboard: [
          [
            { text: enabled ? "✅ Plan On" : "Plan On", callback_data: "planmode:on" },
            { text: !enabled ? "✅ Plan Off" : "Plan Off", callback_data: "planmode:off" },
          ],
          [
            { text: "Toggle", callback_data: "planmode:toggle" },
          ],
        ],
      },
    },
  }
}
