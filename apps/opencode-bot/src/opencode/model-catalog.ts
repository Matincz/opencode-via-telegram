import * as os from "os"
import * as path from "path"
import { readJsonObjectFile } from "@matincz/telegram-bot-core/storage/json"

export interface ProviderConfigEntry {
  models?: Record<string, any>
  whitelist?: string[]
  blacklist?: string[]
  [key: string]: any
}

export interface ProviderInfoLike {
  id: string
  name?: string
  source?: string
  models?: Record<string, any>
  [key: string]: any
}

export interface LocalProviderState {
  authProviderIds: Set<string>
  providerConfig: Record<string, ProviderConfigEntry>
  authPath: string
  globalConfigPath: string
  projectConfigPath?: string
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function mergeProviderEntry(
  baseEntry: ProviderConfigEntry | undefined,
  overrideEntry: ProviderConfigEntry | undefined,
): ProviderConfigEntry | undefined {
  if (!baseEntry && !overrideEntry) return undefined

  const merged: ProviderConfigEntry = {
    ...(baseEntry ?? {}),
    ...(overrideEntry ?? {}),
  }

  const baseModels = isObject(baseEntry?.models) ? baseEntry?.models : {}
  const overrideModels = isObject(overrideEntry?.models) ? overrideEntry?.models : {}
  if (Object.keys(baseModels).length > 0 || Object.keys(overrideModels).length > 0) {
    merged.models = {
      ...baseModels,
      ...overrideModels,
    }
  }

  if (Array.isArray(overrideEntry?.whitelist)) merged.whitelist = [...overrideEntry.whitelist]
  else if (Array.isArray(baseEntry?.whitelist)) merged.whitelist = [...baseEntry.whitelist]

  if (Array.isArray(overrideEntry?.blacklist)) merged.blacklist = [...overrideEntry.blacklist]
  else if (Array.isArray(baseEntry?.blacklist)) merged.blacklist = [...baseEntry.blacklist]

  return merged
}

function mergeProviderConfigMaps(
  baseMap: Record<string, ProviderConfigEntry> | undefined,
  overrideMap: Record<string, ProviderConfigEntry> | undefined,
): Record<string, ProviderConfigEntry> {
  const result: Record<string, ProviderConfigEntry> = {}
  const providerIds = new Set<string>([
    ...Object.keys(isObject(baseMap) ? baseMap : {}),
    ...Object.keys(isObject(overrideMap) ? overrideMap : {}),
  ])

  for (const providerId of providerIds) {
    const merged = mergeProviderEntry(baseMap?.[providerId], overrideMap?.[providerId])
    if (merged) result[providerId] = merged
  }

  return result
}

export function getGlobalOpencodeConfigPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".config", "opencode", "opencode.json")
}

export function getGlobalAuthPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".local", "share", "opencode", "auth.json")
}

export function getProjectOpencodeConfigPath(projectDir: string) {
  return path.join(projectDir, "opencode.json")
}

export function loadLocalProviderState(input?: {
  projectDir?: string
  homeDir?: string
  globalConfigPath?: string
  authPath?: string
}): LocalProviderState {
  const globalConfigPath = input?.globalConfigPath ?? getGlobalOpencodeConfigPath(input?.homeDir)
  const authPath = input?.authPath ?? getGlobalAuthPath(input?.homeDir)
  const projectConfigPath = input?.projectDir ? getProjectOpencodeConfigPath(input.projectDir) : undefined

  const globalConfig = readJsonObjectFile(globalConfigPath)
  const projectConfig = projectConfigPath ? readJsonObjectFile(projectConfigPath) : undefined
  const authData = readJsonObjectFile(authPath)

  return {
    authProviderIds: new Set(Object.keys(authData ?? {})),
    providerConfig: mergeProviderConfigMaps(
      isObject(globalConfig?.provider) ? globalConfig?.provider : undefined,
      isObject(projectConfig?.provider) ? projectConfig?.provider : undefined,
    ),
    authPath,
    globalConfigPath,
    projectConfigPath: projectConfig && projectConfigPath ? projectConfigPath : undefined,
  }
}

function filterModelEntries(
  provider: ProviderInfoLike,
  providerConfig: ProviderConfigEntry | undefined,
  authProviderIds: Set<string>,
): Array<[string, any]> {
  let entries = Object.entries(isObject(provider.models) ? provider.models : {})

  if (Array.isArray(providerConfig?.whitelist) && providerConfig.whitelist.length > 0) {
    const whitelist = new Set(providerConfig.whitelist)
    entries = entries.filter(([modelId]) => whitelist.has(modelId))
  }

  if (Array.isArray(providerConfig?.blacklist) && providerConfig.blacklist.length > 0) {
    const blacklist = new Set(providerConfig.blacklist)
    entries = entries.filter(([modelId]) => !blacklist.has(modelId))
  }

  const configuredModels = isObject(providerConfig?.models) ? providerConfig.models : {}
  const configuredModelIds = Object.keys(configuredModels)
  const shouldUseConfiguredSubset = configuredModelIds.length > 0 && !authProviderIds.has(provider.id)

  if (shouldUseConfiguredSubset) {
    const configuredSet = new Set(configuredModelIds)
    entries = entries.filter(([modelId]) => configuredSet.has(modelId))
  }

  return entries
}

export function buildSelectableProviders(input: {
  serverProviders: ProviderInfoLike[]
  state: LocalProviderState
}): ProviderInfoLike[] {
  return input.serverProviders
    .map((provider) => {
      const models = Object.fromEntries(filterModelEntries(provider, input.state.providerConfig[provider.id], input.state.authProviderIds))
      return {
        ...provider,
        models,
      }
    })
    .filter((provider) => Object.keys(provider.models ?? {}).length > 0)
}
