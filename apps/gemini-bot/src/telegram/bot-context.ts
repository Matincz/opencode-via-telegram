import type TelegramBot from "node-telegram-bot-api"
import type { StoredChatSnapshot } from "../store/snapshots"
import type { GeminiExecutionMode } from "../store/approval-runtime"
import type { ToolApprovalStrategy } from "../gemini/approval"

export interface BotContext {
  bot: TelegramBot
  allowedUserId: string
  geminiBin: string
  geminiCwd: string | undefined
  geminiSandbox: true | string | undefined
  geminiCliHome: string
  rootDir: string
  mediaCacheRoot: string
  token: string
  activeResponses: Map<number, AbortController>
  turnRunner: {
    handlePrompt: (chatId: number, userText: string, attachments: any[]) => Promise<void>
    runExecutionPhase: (chatId: number, userText: string, planText: string, planSessionId: string | undefined, attachments: any[], planArtifactId?: string) => Promise<void>
  }
  getEffectiveModel: (chatId: number) => string | undefined
  getExecutionModel: (chatId: number) => string | undefined
  getPlanModel: (chatId: number) => string | undefined
  getToolApprovalStrategy: (chatId: number) => ToolApprovalStrategy
  getResolvedApprovalRuntime: (chatId: number) => { strategy: ToolApprovalStrategy; executionMode: GeminiExecutionMode; sandbox: boolean }
  getModelPicker: (chatId: number) => { text: string; options: Record<string, any> }
  getSessionModelOverride: (chatId: number) => string | undefined
  getNativeResumeSession: (chatId: number) => string | undefined
  sendModelPicker: (chatId: number) => Promise<void>
  sendSessionPicker: (chatId: number) => Promise<void>
  sendCheckpointPicker: (chatId: number) => Promise<void>
  sendRewindPicker: (chatId: number) => Promise<void>
  switchModel: (chatId: number, model: string, persist?: boolean) => Promise<boolean>
  clearSessionModelOverride: (chatId: number) => Promise<void>
  restoreStoredSnapshot: (chatId: number, snapshot: StoredChatSnapshot) => void
  stopTyping: (chatId: number) => void
  clearActiveDraft: (chatId: number) => void
  persistedGeminiModel: string | undefined
  geminiRetryFetchErrors: boolean
  geminiMaxAttempts: number
  lastResolvedModelMap: Map<number, string>
  lastPlanResolvedModelMap: Map<number, string>
}
