# OpenCode Telegram Bot 全功能整合计划

## 当前需求评估

### 建议优先级

1. 设定 agent / 切换 agent
2. 切换项目 / 指定项目
3. 默认会话名称不显示 Telegram Chat ID
4. 思考过程流推送优化
5. 发送图片 / 文件

### 分项判断

- **设定 agent / 切换 agent**
  - 价值高，和现有 `/plan`、`/build`、`/models` 同一层级，交互模型清晰
  - OpenCode 文档已有 agent 概念与配置，Bridge 侧主要是补 `GET` 可用 agent 列表、当前 agent 状态、切换入口
  - 预计复杂度：中

- **切换项目 / 指定项目**
  - 价值高，直接影响 Telegram 作为远程入口时的可用性
  - 需要先确认 OpenCode server 对项目列表/切换项目的 HTTP 能力，再决定做 InlineKeyboard 选择还是文本指定路径
  - 预计复杂度：中到高

- **默认会话名称不显示 Telegram Chat ID**
  - 价值中，属于低风险体验优化
  - 当前创建会话时写死为 `Telegram Chat ${chatId}`，改动点集中，基本不影响其他流程
  - 预计复杂度：低

- **思考过程流推送优化**
  - 价值中到高，但风险也高
  - 当前问题在于 SSE `reasoning/text delta` 到 Telegram draft/message 的拼接和节流策略，容易牵动整体流式渲染稳定性
  - 建议在功能项之前做一次专项整理，而不是和其他需求混做
  - 预计复杂度：高

- **发送图片 / 文件**
  - 价值高，但前置不只是 Telegram Bot API，还要确认 OpenCode HTTP `message.parts` 对 image/file/pdf 的接收格式与权限处理
  - 这项会同时涉及 Telegram 入站媒体解析、文件下载、本地暂存、OpenCode part 构造和失败兜底
  - 预计复杂度：高

### 发送图片 / 文件复杂度来源

- Telegram 入站消息不是统一文本结构，图片走 `photo`，通用文件走 `document`，可选说明文字走 `caption`，当前 Bridge 只处理 `msg.text`
- Telegram 文件不能直接拿来发给 OpenCode，必须先用 `getFile` 换取 `file_path`，再按 `https://api.telegram.org/file/bot<token>/<file_path>` 下载，且 Bot API 下载上限是 20 MB
- OpenCode 虽然支持媒体，但 HTTP `POST /session/:id/message` 仍然要求构造正确的 `parts`；源码侧实际内部落盘的是 `{ type: "file", url, filename, mime }`，图片通常也会被编码成 `data:<mime>;base64,...`
- 这意味着 Bridge 需要补齐 MIME 判断、文件名保留、图片与普通文件分流、可能的 base64/data URL 转换，以及失败时的用户提示

### 参考 OpenClaw 的实现结论

- OpenClaw 没有把 Telegram 附件处理直接塞进消息入口，而是拆成了独立媒体流水线：先识别 `photo/video/document/audio/voice/sticker`，再统一下载、落临时文件、回填 `MediaPath/MediaPaths/MediaType/MediaTypes`
- Telegram 侧会先调用 `getFile`，并对网络错误做重试；对超过 Bot API 20 MB 上限的文件直接跳过，并向用户返回明确错误提示
- 多图相册和转发消息不是逐条立即送进模型，而是先做 debounce / media group 聚合，再把多张图作为 `MediaPaths` 一次性交给后续 agent 处理
- 当消息没有文字但有媒体时，OpenClaw 会生成占位正文，例如 `[User sent media without caption]` 或 `<media:image>`，避免模型输入为空
- 它传给 agent 的并不是 Telegram 原始对象，而是整理后的上下文：正文、会话信息、回复上下文、媒体路径数组、媒体类型数组、可选转写结果
- 这说明“支持图片/文件”真正需要补的是媒体管线和上下文规范，而不是只给现有 `POST /session/:id/message` 临时加一个附件字段

### 最彻底实现方案

#### 总体原则

- 不在现有 `index.ts` 的文本入口上继续打补丁，而是把“入站消息”和“媒体解析”拆成一等子系统
- Telegram 到 OpenCode 不直接发送 base64 大 JSON，优先把附件下载到本机临时目录，再以 `file://` 形式传给 OpenCode；OpenCode server 自己会把 `file://` 读取并转换成内部 `data:` 文件 part
- 一次性把单图、相册、通用文件、caption、reply 上下文、失败提示、清理机制都设计进去，避免做完第一版又整体返工

#### 建议目标形态

1. **消息标准化层**
   - 新增统一的 `NormalizedInboundMessage`
   - 字段至少包含：`chatId`、`messageId`、`text`、`caption`、`attachments[]`、`mediaGroupId`、`replyTo`、`from`
   - 入口不再直接依赖 `msg.text`，而是先把 Telegram 原始消息转成标准结构

2. **媒体解析层**
   - 新增 `telegram/media-resolver`
   - 负责：
     - 识别 `photo/document/video/audio/voice/sticker`
     - 调用 `getFile`
     - 下载媒体到临时目录
     - 保留 `filename` / `mime`
     - 对超限、缺少 `file_path`、下载失败给出明确错误
   - 媒体元数据建议至少保留：`kind`、`path`、`mime`、`filename`、`telegramFileId`、`fileUniqueId`

3. **媒体组聚合层**
   - 新增 `telegram/media-group-buffer`
   - 对 `media_group_id` 做短时间聚合，确保相册一次性作为多个附件进入同一条 OpenCode 消息
   - 普通文本消息与媒体消息分别走不同 debounce 策略，避免把多图拆成多轮 AI 输入

4. **OpenCode parts 构造层**
   - 新增 `opencode/build-message-parts`
   - 统一输出 `parts: Array<TextPartInput | FilePartInput>`
   - 规则：
     - caption / 文本 -> `text` part
     - 下载后的附件 -> `file` part
     - `url` 使用本机绝对路径生成的 `file://`
     - `mime` 和 `filename` 使用下载后的真实信息
   - 当用户只发附件不写字时，自动补一个最小文本 part，例如 `请分析附件内容。`
     - 更稳妥，不依赖服务端对“只有 file parts 无 text part”的隐式容忍

5. **临时文件生命周期**
   - 新增 `media-cache`
   - 目录建议独立，例如 `./.cache/telegram-media/`
   - 每条消息单独子目录，便于清理和排障
   - 清理策略：
     - 成功发送给 OpenCode 后延迟清理
     - 异常中断时保留短期缓存便于重试
     - 增加定时 GC，按 TTL 删除旧文件

6. **错误与用户体验层**
   - 统一错误文案：
     - 文件超过 Telegram 20 MB 下载上限
     - 下载失败
     - 不支持的媒体类型
     - OpenCode 接收失败
   - 发送附件时也保持 `typing/upload_document` 等状态提示
   - 相册、单图、单文件的提示文案要区分，避免用户误判 bridge 卡住

7. **结构重构**
   - 为了让这项功能长期可维护，建议同步拆分当前单文件：
     - `telegram/bot.ts`
     - `telegram/inbound.ts`
     - `telegram/media.ts`
     - `telegram/callbacks.ts`
     - `opencode/client.ts`
     - `opencode/message-parts.ts`
     - `store/session-store.ts`
     - `store/model-store.ts`
   - 如果继续维持全部逻辑堆在 `index.ts`，图片/文件一接入，后续问题会明显增多

#### 我对“最优传输方式”的结论

- **最佳方案：Bridge 下载 Telegram 附件到本机临时文件，然后给 OpenCode 发送 `file://` part**
- 原因：
  - 避免 bridge 自己把大文件转成 base64，减少内存峰值和请求体尺寸
  - OpenCode 已经原生支持 `file://`，并会在 server 内部安全地读成 `data:` part
  - 这和 OpenCode CLI/TUI 传文件的主路径一致，兼容性最好

#### 如果按“不惜代价”的标准，我建议的实施顺序

1. 先做结构重构，把文本入口和 Telegram 交互逻辑拆开
2. 再做入站媒体解析和临时文件生命周期
3. 再做 OpenCode `parts` 适配和相册聚合
4. 最后补测试、日志、GC 和异常恢复

#### 测试要求

- 图片 / 文件功能完成后，必须同时交付测试，不接受“功能先上、测试以后补”
- 当前仓库还没有测试脚本，后续实现时需要一并补齐最小测试基础设施，并在 `package.json` 中增加可执行脚本
- 目标测试层次：
  1. **单元测试**
     - `NormalizedInboundMessage` 构造
     - Telegram 消息到 OpenCode `parts` 的映射
     - caption / 无 caption / 单文件 / 多文件 / 相册的规则
     - MIME、文件名、超限判断、错误分支
  2. **集成测试**
     - mock Telegram `getFile` 与下载响应
     - 验证附件能正确落到临时目录
     - 验证最终发给 OpenCode 的请求体包含正确的 `text/file` parts
     - 验证相册聚合后只触发一次 OpenCode 请求
  3. **回归测试**
     - 纯文本消息能力不回归
     - `/models`、`/sessions`、权限审批、SSE 流式渲染不受媒体功能影响
  4. **手工 smoke 流程**
     - Telegram 单图
     - Telegram 多图相册
     - Telegram PDF / 文档
     - 无 caption 附件
     - 大文件失败提示
     - 下载失败提示

#### 测试完成标准

- 本地可一条命令执行测试
- 新增媒体功能至少覆盖单元测试和集成测试
- 合并前必须跑一次 smoke 流程
- 如果某类能力暂时无法自动化，必须在任务记录里明确写出缺口，而不是静默跳过

#### 当前实现状态（2026-03-08）

- 已完成 Telegram 入站附件到 OpenCode `file:// parts` 的主链路
- 已完成 `media_group_id` 相册聚合
- 已完成附件兼容性收敛：
  - prompt 消息发送前会根据当前模型的 `capabilities` 判断哪些附件可以原生内联
  - 文本类与模型不支持的附件会降级为本地路径提示，由模型按需通过 `Read` 工具读取
  - OpenCode 返回 `session.error` 时，Telegram 会直接显示错误详情，并对旧会话中的不兼容附件给出 `/new` 提示
- 已完成自动化测试基础设施：`bun test`、`bun run check`
- 已完成自动化覆盖：标准化、下载、parts 构造、媒体组缓冲、请求体发送
- 已完成 `/models` 的同步契约收敛：以 OpenCode server 作为元数据源，再用 `auth.json` 与 `opencode.json` 决定模型展开策略
- 仍待完成的仅剩真实 Telegram 手工 smoke 验收

#### 目标完成标准

- Telegram 发送单张图片，可被 OpenCode 正确识别为视觉输入
- Telegram 发送多图相册，作为同一轮用户输入进入 OpenCode
- Telegram 发送 PDF / 文档，可被 OpenCode 正确接收为 `file` part
- 仅附件无 caption 时仍能稳定触发 AI 响应
- 超大文件、下载失败、未知 MIME 都有明确提示
- 临时文件不会无限堆积
- 旧的纯文本能力、模型切换、SSE 流式输出、权限审批不回归

## 目标
根据 OpenCode 服务器 API 文档，将所有可用功能都集成到 Telegram Bot 中，实现完整的自动化编程助手体验。

## 拟实现功能清单

### 1. 🔐 权限审批系统（最关键）
当 OpenCode 执行危险操作（如 bash、文件写入）时，实时通过 Telegram 推送**交互式审批按钮**（once / always / reject），用户用手机点按即可完成审批，不再依赖于命令行 TUI。

- **SSE 事件**：监听 `session.permission` 事件
- **API**：`POST /session/:id/permissions/:permissionID` body: `{ response: "once"|"always"|"reject" }`
- **Telegram 实现**：发送 InlineKeyboard 消息，三个按钮，点击后调用 API 并删除 / 更新按钮消息

### 2. 🗺️ 模式切换（已部分实现，修正方式）
当前 `/plan` 用 `agent` 参数实现，但正确方式是通过内置 slash 命令 `/mode plan` 和 `/mode build` 来切换（通过 `POST /session/:id/command`），以确保 OpenCode 知道当前模式。

- **Telegram 命令**：`/plan` → `/mode plan`，`/build` → `/mode build`
- **API**：`POST /session/:id/command` body `{ command: "/mode", arguments: "plan" }`

### 3. 📋 列出并执行自定义命令
自动从 OpenCode 获取用户配置的自定义命令列表，并在 Telegram 中列出、点选执行。

- **Telegram 命令**：`/commands` — 列出所有可用命令（含内置+自定义）
- **执行方式**：发送 InlineKeyboard，点击按钮执行对应命令
- **API**：`GET /command` 列出，`POST /session/:id/command` 执行

### 4. 🔗 会话分享（/share、/unshare）
- **Telegram 命令**：`/share` → 调用 `POST /session/:id/share`，返回 URL 发回
- **Telegram 命令**：`/unshare` → 调用 `DELETE /session/:id/share`

### 5. ↩️ Undo/Redo（/undo、/redo）
- **Telegram 命令**：`/undo` → `POST /session/:id/command` body `{ command: "/undo" }`
- **Telegram 命令**：`/redo` → `POST /session/:id/command` body `{ command: "/redo" }`

### 6. 🤖 模型切换（/models、/model <id>）
- **Telegram 命令**：`/models` — 列出 InlineKeyboard 显示可用 Provider 和 Model
- **切换实现**：`PATCH /config` body `{ model: "provider/modelId" }`
- **API**：`GET /config/providers`

### 7. 📊 增强的 /status 命令
- 当前项目路径
- 当前模式（plan/build）
- 当前使用的模型
- 会话 ID，消息数

### 8. 📝 会话管理（/sessions、/switch）
- **Telegram 命令**：`/sessions` — 列出已有会话（InlineKeyboard 点击切换）
- **Telegram 命令**：`/switch <id>` — 切换到指定会话

---

## 修改文件

### [MODIFY] [index.ts](file:///Users/matincz/opencode/opencode-via-telegram/index.ts)

#### 主要改动：
| # | 功能 | 改动摘要 |
|---|------|---------|
| 1 | 权限审批系统 | 在 SSE 监听中增加 `session.permission` 事件处理，发送 InlineKeyboard 按钮消息，监听 `callback_query` 响应 |
| 2 | /plan /build 修正 | 改为通过 `POST /session/:id/command` 的 `/mode` 命令实现真正的模式切换 |
| 3 | /commands 命令 | 新增列出可用命令的功能，点击执行 |
| 4 | /share /unshare | 调用 share API |
| 5 | /undo /redo | 调用 command API |
| 6 | /models | 列出模型并支持切换 |
| 7 | /status 增强 | 增加模型、模式、項目信息 |
| 8 | /sessions | 列出并切换会话 |
| 9 | setMyCommands 更新 | 向 Telegram 注册所有新命令 |

---

## 验证计划

1. 发送一个会触发权限审批的问题（如"帮我执行 ls 命令"），确认 Telegram 收到审批按钮
2. 点击 once/always/reject，确认 OpenCode 正确响应
3. 测试 `/plan` 切换模式后再问问题，确认模型响应符合 plan 模式限制
4. 测试 `/share` 返回可访问的公开 URL
5. 测试 `/undo` 撤销最后一条消息
6. 测试 `/models` 列出并切换模型

> [!CAUTION]
> **权限审批**是最重要的新功能，需要在 SSE 事件监听中正确识别 `session.permission` 事件。如果 SSE 中的权限事件结构与预期不同，可能需要调整事件解析逻辑。
