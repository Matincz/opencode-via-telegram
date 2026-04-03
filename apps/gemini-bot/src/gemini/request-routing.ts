import type { ResolvedTelegramAttachment } from "../telegram/types"

export interface GeminiRequestRoute {
  mode: "direct" | "agent"
  reason: string
}

const AGENT_PATTERNS = [
  /(^|\s)@\/[\w./-]+/i,
  /(查看|看看|读取|打开|列出|浏览|分析|扫描)\s*(文件|目录|文件夹|代码|项目|仓库)/i,
  /\b(view|read|open|list|browse|analy[sz]e|scan)\s*(file|files|directory|folder|code|project|repo|repository)\b/i,
  /(修改|编辑|重构|修复|实现|添加|删除|重命名|创建|生成|写入|更新).{0,10}(文件|目录|文件夹|代码|项目|仓库|函数|模块|组件|配置|bug)/i,
  /\b(edit|modify|refactor|fix|implement|rename)\s+(the\s+)?(file|code|function|module|component|config|bug)\b/i,
  /(运行|执行|启动|停止|重启|安装|部署|编译|构建|测试|调试|提交)\s*(命令|脚本|项目|服务|程序|代码)?/i,
  /\b(run|execute|start|stop|restart|install|deploy|build|test|debug|commit)\s+(the\s+)?(command|script|server|service|project|code|tests?)?\b/i,
  /(终端|命令行|脚本)/i,
  /\b(bash|shell|terminal)\b/i,
  /\b(mcp|sandbox|yolo)\b/i,
]

const DIRECT_PATTERNS = [
  /(天气|气温|温度|下雨|空气质量)/i,
  /\b(weather|temperature|forecast|rain)\b/i,
  /(你好|您好|嗨|早上好|下午好|晚上好|说中文)/i,
  /\b(hello|hi|hey|speak chinese)\b/i,
  /(是什么|什么意思|怎么理解|介绍一下|解释一下|总结一下|翻译)/i,
  /\b(what is|explain|summari[sz]e|translate|tell me about)\b/i,
]

export function classifyGeminiRequest(userText: string, attachments: ResolvedTelegramAttachment[]): GeminiRequestRoute {
  const text = userText.trim()

  if (!text) {
    return attachments.length > 0
      ? { mode: "direct", reason: "attachment_analysis" }
      : { mode: "direct", reason: "empty_prompt" }
  }

  for (const pattern of AGENT_PATTERNS) {
    if (pattern.test(text)) {
      return { mode: "agent", reason: "agent_pattern" }
    }
  }

  for (const pattern of DIRECT_PATTERNS) {
    if (pattern.test(text)) {
      return { mode: "direct", reason: "direct_pattern" }
    }
  }

  if (attachments.length > 0) {
    return { mode: "direct", reason: "attachment_question" }
  }

  return { mode: "direct", reason: "default_direct" }
}
