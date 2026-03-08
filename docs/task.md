# 为 Telegram Bot 引入 /plan、/build、/stop 命令

## 工作流同步

- [x] 建立项目内 `docs/*.md` 到 Obsidian 目录 `/Users/matincz/Documents/Obsidian Vault/opencode via telegram` 的同步约定
- [x] 将“完成需求后同步勾选 `/Users/matincz/Documents/Obsidian Vault/opencode via telegram/修改需求.md`”固化到项目级 AGENTS 规则
- [x] 将同步脚本改为直接写入目标 Vault 目录

## 任务列表

- [x] 阅读 OpenCode 文档，了解 plan/build 切换和 stop 的 API 端点
- [x] 权限审批系统（SSE 权限事件 + InlineKeyboard 按钮）
    - **已修复**：因包含超出 64 字节超长 sessionId 导致的 `BUTTON_DATA_INVALID` 错误引发静默失败的问题
- [x] /plan /build 模式切换（修正为通过 /mode 内置命令）
- [x] /commands 自定义命令列表（点击执行）
- [x] /share /unshare 分享功能
- [x] /undo /redo 撤销重做
- [x] /models 二级菜单下钻选择模型
    - 解决了 TG `callback_data` 64 字节限制问题
    - 新增 Providers 菜单分类，点击展开具体模型并支持返回
    - **已增加 `connected` 过滤，仅显示用户已配置了 API Key 的模型供应商**模型切换
    - 将 OpenCode 的 `google` provider 在 Telegram 中显示为 `Gemini (Google)`，避免用户误以为 Gemini 未同步
    - `/models` 现采用“server 元数据 + 本地配置过滤”的混合逻辑：
      - 认证型 provider（来自 `~/.local/share/opencode/auth.json`）展开 server 当前可用的全量模型
      - 自定义 provider（仅在 `opencode.json` 中声明 `models`）只展开配置里显式写出的模型
      - 若存在 `whitelist / blacklist`，Telegram 侧同步遵守相同过滤规则
- [x] /status 增强（含模型、项目路径）
- [x] /sessions 历史会话查看切换
- [x] 更新 Telegram 命令菜单
- [x] TypeScript 编译验证
- [x] 重启服务并验证
- [x] 参考本地 `openclaw` 实现，分析 Telegram 图片/文件媒体流水线
    - 确认其采用 `getFile -> 下载 -> 临时文件 -> MediaPath/MediaPaths 上下文` 的分层实现，而不是在消息入口直接内联拼接
    - 确认其对多图相册、caption 缺失、超大文件、sticker 和音频预处理都有单独分支
- [x] 明确“最彻底实现发送图片/文件”的目标方案
    - 确认 OpenCode `POST /session/:id/message` 的 `parts` 支持原生 `file://` 输入
    - 确认最优桥接方式应为“Telegram 下载到本机临时文件 -> 发送 `file://` part 给 OpenCode”
- [x] 实现 Telegram 图片 / 文件入站能力
    - 支持 `photo`、`document`、`video`、`audio`、`voice`、`animation`、静态 `sticker`
    - 支持 `media_group_id` 相册聚合
    - 支持附件无 caption 时自动补 fallback text
    - 支持 slash command 携带 `file` parts 转发到 OpenCode
    - 已修复附件 prompt 链路中的模型兼容性问题：
      - 仅对当前模型明确支持的媒体类型发送原生 `file` parts
      - `text/markdown`、JSON、模型不支持的 PDF / 音视频等附件改为文本提示，引导模型按需调用 `Read` 工具
      - 新增 `session.error` 直出到 Telegram，避免用户只看到 `typing...` 或 `Called the Read tool...` 后无下文
- [x] 加入图片 / 文件自动化测试流程
    - 新增 `bun test` 与 `bun run check`
    - 覆盖标准化、下载缓存、OpenCode `parts` 构造、媒体组缓冲、请求体发送
- [ ] 手工 Telegram smoke 验收
    - 单图、多图相册、PDF / 文档、大文件失败提示仍需在真实聊天里最终验收
- [x] 代码脱敏与 GitHub 发布准备
    - 检查确任所有 Telegram/OpenCode 的密钥与 URL 已解耦存放于未受 Git 跟踪的 `.env` 中
    - 撰写新版长篇更新日志，完成 `git commit`
    - *(由于 SSH/HTTPS 权限校验问题，最后的推送到远端交由用户手动执行 `git push`)*
- [x] 修复输入框思考气泡（草稿遗留）不消失的问题
- [x] 修复长久出现 `typing...` （输入中）的问题，并在错误捕捉中清理定时器
- [x] 加入自动删除机制（思考过程消息发送后一分钟自动调用 `deleteMessage` 销毁）
- [x] 更新 `TELEGRAM_BOT_TOKEN` 为新分配的 Token ✨
