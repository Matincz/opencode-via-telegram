import type { GeminiConfigSnapshot } from "../gemini/mcp"
import type { PlanArtifact } from "../store/plan-artifacts"
import { escapeHtml } from "./rendering"

function planStatusLabel(status: PlanArtifact["status"]) {
  switch (status) {
    case "pending_approval":
      return "待审批"
    case "approved":
      return "已批准"
    case "executing":
      return "执行中"
    case "completed":
      return "已完成"
    case "rejected":
      return "已拒绝"
    case "failed":
      return "失败"
  }
}

function todoStatusLabel(status: PlanArtifact["todos"][number]["status"]) {
  switch (status) {
    case "pending":
      return "⬜"
    case "running":
      return "🟡"
    case "done":
      return "✅"
    case "failed":
      return "❌"
  }
}

export function renderPlanArtifactHtml(artifact: PlanArtifact) {
  const lines = [
    "<b>最近计划</b>",
    `状态：<code>${planStatusLabel(artifact.status)}</code>`,
    `计划模型：<code>${escapeHtml(artifact.planModel || "Gemini CLI 默认")}</code>`,
    `执行模型：<code>${escapeHtml(artifact.executionModel || "Gemini CLI 默认")}</code>`,
    `创建时间：<code>${escapeHtml(artifact.createdAt)}</code>`,
    `计划文件：<code>${escapeHtml(artifact.markdownPath)}</code>`,
    "",
    "<b>Todo</b>",
  ]

  if (artifact.todos.length === 0) {
    lines.push("• 未提取到步骤")
  } else {
    for (const todo of artifact.todos) {
      lines.push(`${todoStatusLabel(todo.status)} ${escapeHtml(todo.text)}`)
    }
  }

  lines.push("", "<b>Plan</b>", `<blockquote expandable>${escapeHtml(artifact.planText).slice(0, 3000)}</blockquote>`)

  if (artifact.resultSummary) {
    lines.push("", "<b>执行结果</b>", `<blockquote expandable>${escapeHtml(artifact.resultSummary).slice(0, 1500)}</blockquote>`)
  }

  if (artifact.errorMessage) {
    lines.push("", "<b>错误</b>", `<code>${escapeHtml(artifact.errorMessage).slice(0, 1500)}</code>`)
  }

  return lines.join("\n")
}

export function renderTodoProgressPlain(artifact: PlanArtifact) {
  const lines = [`🗂 计划进度：${planStatusLabel(artifact.status)}`]

  if (artifact.todos.length === 0) {
    lines.push("• 未提取到步骤")
  } else {
    for (const todo of artifact.todos) {
      lines.push(`${todoStatusLabel(todo.status)} ${todo.text}`)
    }
  }

  return lines.join("\n")
}

export function renderTodoProgressHtml(artifact: PlanArtifact) {
  const lines = [`🗂 <b>计划进度</b>：<code>${planStatusLabel(artifact.status)}</code>`]

  if (artifact.todos.length === 0) {
    lines.push("• 未提取到步骤")
  } else {
    for (const todo of artifact.todos) {
      lines.push(`${todoStatusLabel(todo.status)} ${escapeHtml(todo.text)}`)
    }
  }

  return lines.join("\n")
}

export function renderMcpStatusHtml(snapshot: GeminiConfigSnapshot) {
  const lines = [
    "<b>MCP 状态</b>",
    `CLI Home：<code>${escapeHtml(snapshot.cliHome)}</code>`,
    `Project Settings：<code>${escapeHtml(snapshot.projectSettingsPath)}</code>`,
    `Home Settings：<code>${escapeHtml(snapshot.homeSettingsPath)}</code>`,
    `YOLO 限制：<code>${snapshot.yoloDisabled ? "disabled" : "enabled"}</code>`,
    "",
    "<b>Servers</b>",
  ]

  if (snapshot.mcpServers.length === 0) {
    lines.push("• 当前未发现 MCP server 配置")
  } else {
    for (const server of snapshot.mcpServers) {
      lines.push(`• <code>${escapeHtml(server.name)}</code> [${server.scope}] ${server.trusted ? "trusted" : "untrusted"}`)
    }
  }

  return lines.join("\n")
}

export function renderToolsStatusHtml(snapshot: GeminiConfigSnapshot, toolSummary: string[]) {
  const lines = [
    "<b>Tools 状态</b>",
    `包含过滤：<code>${escapeHtml(snapshot.includeTools.join(", ") || "none")}</code>`,
    `排除过滤：<code>${escapeHtml(snapshot.excludeTools.join(", ") || "none")}</code>`,
    "",
    "<b>最近计划预测工具</b>",
  ]

  if (toolSummary.length === 0) {
    lines.push("• 暂无")
  } else {
    for (const tool of toolSummary.slice(0, 12)) {
      lines.push(`• <code>${escapeHtml(tool)}</code>`)
    }
  }

  return lines.join("\n")
}
