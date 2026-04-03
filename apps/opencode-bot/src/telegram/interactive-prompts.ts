export function renderPermissionRequestText(
  perm: any,
  escapeHtml: (value: string) => string,
) {
  const permType = perm?.permission || "未知权限"
  const patterns = perm?.patterns?.join(", ") || ""
  const metadata = perm?.metadata || {}
  const filepath = metadata?.filepath || metadata?.command || ""

  return (
    `⚠️ <b>权限审批请求</b>\n\n` +
    `🔒 <b>权限：</b><code>${escapeHtml(String(permType))}</code>\n` +
    (filepath ? `📄 <b>路径：</b><code>${escapeHtml(String(filepath)).substring(0, 300)}</code>\n` : "") +
    (patterns ? `📂 <b>匹配：</b><code>${escapeHtml(String(patterns)).substring(0, 200)}</code>\n` : "") +
    `\n请选择处理方式：`
  )
}

export function renderQuestionRequestText(
  request: any,
  escapeHtml: (value: string) => string,
) {
  const questions = Array.isArray(request?.questions) ? request.questions : []
  const total = questions.length
  const lines = [`❓ <b>OpenCode 提问</b>`, `${total} OF ${total} question${total === 1 ? "" : "s"}`]

  questions.forEach((question: any, index: number) => {
    const questionLines = [
      total > 1 ? `<b>${index + 1} / ${total}</b>` : "",
      question?.header ? `🏷 <b>${escapeHtml(String(question.header))}</b>` : "",
      question?.question ? escapeHtml(String(question.question)) : "",
    ].filter(Boolean)

    const options = Array.isArray(question?.options) ? question.options : []
    if (options.length > 0) {
      questionLines.push(
        "",
        ...options.map((option: any, optionIndex: number) => {
          const label = escapeHtml(String(option?.label || ""))
          const description = option?.description ? ` - ${escapeHtml(String(option.description))}` : ""
          return `${optionIndex + 1}. <b>${label}</b>${description}`
        }),
      )
    }

    if (question?.custom !== false) {
      questionLines.push("", "也可以选择“✍️ 自定义回答”后直接发送一条文字。")
    }

    lines.push(...questionLines)
  })

  return lines.filter(Boolean).join("\n")
}

export const UNSUPPORTED_QUESTION_NOTICE =
  "⚠️ 当前 Telegram 仅支持单题单选直接作答；多题或多选请先在桌面端处理。"
