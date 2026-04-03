import { describe, expect, it } from "bun:test"
import { buildExecutionApprovalMessage } from "./approval"

describe("buildExecutionApprovalMessage", () => {
  it("includes request metadata and attachment summary", () => {
    const message = buildExecutionApprovalMessage({
      token: "tok",
      userText: "帮我改这个文件",
      model: "gpt-5.4",
      effort: "high",
      permissionMode: "bypassPermissions",
      attachments: [
        {
          kind: "document",
          path: "/tmp/demo.ts",
          mime: "text/plain",
          filename: "demo.ts",
          telegramFileId: "f1",
          messageId: 1,
          sizeBytes: 42,
        },
      ],
    })

    expect(message.text).toContain("执行审批")
    expect(message.text).toContain("gpt-5.4")
    expect(message.text).toContain("demo.ts")
    expect(message.options.reply_markup.inline_keyboard[0]?.[0]?.callback_data).toBe("codex-approve:run:tok")
  })
})
