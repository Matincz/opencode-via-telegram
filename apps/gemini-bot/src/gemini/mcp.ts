import * as path from "path"
import { isJsonObject, readJsonFile } from "@matincz/telegram-bot-core/storage/json"

export interface GeminiMcpServerInfo {
  name: string
  scope: "project" | "home"
  trusted: boolean
  command?: string
}

export interface GeminiConfigSnapshot {
  cliHome: string
  projectSettingsPath: string
  homeSettingsPath: string
  yoloDisabled: boolean
  includeTools: string[]
  excludeTools: string[]
  mcpServers: GeminiMcpServerInfo[]
}

function parseStringArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean)
}

function getNestedObject(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key]
    if (isJsonObject(value)) {
      return value
    }
  }
  return null
}

function getServerEntries(
  settings: Record<string, unknown>,
  scope: "project" | "home",
  trustedNames: Set<string>,
) {
  const target = getNestedObject(settings, ["mcpServers"]) || getNestedObject(settings, ["mcp"])?.servers
  if (!target) return [] as GeminiMcpServerInfo[]

  if (Array.isArray(target)) {
    return target
      .filter((item) => isJsonObject(item) && typeof item.name === "string")
      .map((item) => ({
        name: String(item.name).trim(),
        scope,
        trusted: trustedNames.has(String(item.name).trim()),
        command: typeof item.command === "string" ? item.command.trim() : undefined,
      }))
  }

  if (!isJsonObject(target)) return [] as GeminiMcpServerInfo[]

  return Object.entries(target).map(([name, value]) => ({
    name,
    scope,
    trusted: trustedNames.has(name),
    command: isJsonObject(value) && typeof value.command === "string" ? value.command.trim() : undefined,
  }))
}

function getTrustedServerNames(settings: Record<string, unknown>) {
  const direct = parseStringArray(settings.trustedMcpServers)
  const mcp = isJsonObject(settings.mcp) ? settings.mcp : null
  const mcpTrusted = mcp ? parseStringArray((mcp as Record<string, unknown>).trustedServers) : []
  return new Set([...direct, ...mcpTrusted])
}

function parseToolFilters(settings: Record<string, unknown>) {
  const tools = isJsonObject(settings.tools) ? settings.tools : null
  const mcp = isJsonObject(settings.mcp) ? settings.mcp : null
  return {
    includeTools: [
      ...parseStringArray(tools ? (tools as Record<string, unknown>).include : undefined),
      ...parseStringArray(mcp ? (mcp as Record<string, unknown>).includeTools : undefined),
    ],
    excludeTools: [
      ...parseStringArray(tools ? (tools as Record<string, unknown>).exclude : undefined),
      ...parseStringArray(mcp ? (mcp as Record<string, unknown>).excludeTools : undefined),
    ],
  }
}

export function getGeminiConfigSnapshot(input: { rootDir?: string; cliHome: string }): GeminiConfigSnapshot {
  const rootDir = input.rootDir || process.cwd()
  const projectSettingsPath = path.join(rootDir, ".gemini", "settings.json")
  const homeSettingsPath = path.join(input.cliHome, ".gemini", "settings.json")
  const projectSettings = readJsonFile(projectSettingsPath)
  const homeSettings = readJsonFile(homeSettingsPath)
  const project = isJsonObject(projectSettings) ? projectSettings : {}
  const home = isJsonObject(homeSettings) ? homeSettings : {}
  const trustedNames = new Set([
    ...Array.from(getTrustedServerNames(project)),
    ...Array.from(getTrustedServerNames(home)),
  ])
  const toolFilters = parseToolFilters(project)
  const homeToolFilters = parseToolFilters(home)
  const projectSecurity = isJsonObject(project.security) ? project.security : null
  const homeSecurity = isJsonObject(home.security) ? home.security : null

  return {
    cliHome: input.cliHome,
    projectSettingsPath,
    homeSettingsPath,
    yoloDisabled: Boolean(projectSecurity?.disableYoloMode || homeSecurity?.disableYoloMode),
    includeTools: [...new Set([...toolFilters.includeTools, ...homeToolFilters.includeTools])],
    excludeTools: [...new Set([...toolFilters.excludeTools, ...homeToolFilters.excludeTools])],
    mcpServers: [
      ...getServerEntries(project, "project", trustedNames),
      ...getServerEntries(home, "home", trustedNames),
    ],
  }
}
