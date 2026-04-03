export function buildSandboxModePickerMessage(enabled: boolean) {
  return {
    text: [
      "<b>沙箱模式</b>",
      `当前状态：<code>${enabled ? "on" : "off"}</code>`,
      enabled
        ? "当前执行阶段会启用 Gemini CLI 沙箱。"
        : "当前执行阶段不启用 Gemini CLI 沙箱。",
      "",
      "点按钮即可切换。",
    ].join("\n"),
    options: {
      parse_mode: "HTML" as const,
      reply_markup: {
        inline_keyboard: [
          [
            { text: enabled ? "✅ Sandbox On" : "Sandbox On", callback_data: "sandboxmode:on" },
            { text: !enabled ? "✅ Sandbox Off" : "Sandbox Off", callback_data: "sandboxmode:off" },
          ],
          [
            { text: "Toggle", callback_data: "sandboxmode:toggle" },
          ],
        ],
      },
    },
  }
}
