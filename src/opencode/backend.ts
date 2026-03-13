import * as fs from "fs"
import * as os from "os"
import * as path from "path"

export interface OpenCodeBackend {
  baseUrl: string
  headers: Record<string, string>
  source: "desktop-sidecar" | "desktop-default-url" | "env"
}

export interface OpenCodeProjectLike {
  id: string
  worktree?: string
  vcs?: string
  source?: "backend" | "desktop-local"
}

const DEFAULT_OPENCODE_URL = process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096"
const DEFAULT_OPENCODE_USERNAME = process.env.OPENCODE_SERVER_USERNAME || "opencode"
const DEFAULT_OPENCODE_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD
const BACKEND_CACHE_TTL_MS = Number(process.env.OPENCODE_BACKEND_CACHE_TTL_MS || "5000")

let cachedBackend: OpenCodeBackend | null = null
let cachedBackendAt = 0
let lastLoggedBackendKey = ""

export function buildBasicAuthHeader(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function decodeOutput(bytes: Uint8Array | undefined) {
  return new TextDecoder().decode(bytes || new Uint8Array())
}

function runCommand(cmd: string[]) {
  const result = Bun.spawnSync({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
  })

  return {
    stdout: decodeOutput(result.stdout),
    stderr: decodeOutput(result.stderr),
    exitCode: result.exitCode,
  }
}

function normalizeHostnameForUrl(hostname: string) {
  if (hostname === "0.0.0.0") return "127.0.0.1"
  if (hostname === "::") return "[::1]"
  if (hostname.includes(":") && !hostname.startsWith("[")) return `[${hostname}]`
  return hostname
}

export function parseDesktopSidecarPidList(psOutput: string) {
  const rows: number[] = []

  for (const line of psOutput.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const match = trimmed.match(/^(\d+)\s+(.*)$/)
    if (!match) continue

    const pid = Number(match[1])
    const command = match[2]

    if (!Number.isFinite(pid)) continue
    if (!command.includes("/Applications/OpenCode.app/Contents/MacOS/opencode-cli")) continue
    if (!command.includes(" serve ")) continue
    if (!command.includes(" --port ")) continue

    rows.push(pid)
  }

  return rows.sort((a, b) => b - a)
}

export function parseDesktopSidecarBackend(psOutput: string): OpenCodeBackend | null {
  const hostname = psOutput.match(/\s--hostname\s+([^\s]+)/)?.[1]
  const port = psOutput.match(/\s--port\s+([0-9]+)/)?.[1]
  const password = psOutput.match(/\bOPENCODE_SERVER_PASSWORD=([^\s]+)/)?.[1]
  const username = psOutput.match(/\bOPENCODE_SERVER_USERNAME=([^\s]+)/)?.[1] || "opencode"

  if (!hostname || !port || !password) return null

  return {
    baseUrl: `http://${normalizeHostnameForUrl(hostname)}:${port}`,
    headers: {
      Authorization: buildBasicAuthHeader(username, password),
    },
    source: "desktop-sidecar",
  }
}

export function getDesktopSettingsPath(homeDir = os.homedir(), platform = process.platform) {
  if (process.env.OPENCODE_DESKTOP_SETTINGS_PATH) return process.env.OPENCODE_DESKTOP_SETTINGS_PATH

  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "ai.opencode.desktop", "opencode.settings.dat")
  }

  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(homeDir, "AppData", "Roaming")
    return path.join(appData, "ai.opencode.desktop", "opencode.settings.dat")
  }

  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(homeDir, ".local", "share")
  return path.join(xdgDataHome, "ai.opencode.desktop", "opencode.settings.dat")
}

export function getDesktopStateDir(homeDir = os.homedir(), platform = process.platform) {
  return path.dirname(getDesktopSettingsPath(homeDir, platform))
}

export function getDesktopGlobalStatePath(homeDir = os.homedir(), platform = process.platform) {
  return path.join(getDesktopStateDir(homeDir, platform), "opencode.global.dat")
}

export function parseDesktopSettingsServerUrl(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed?.defaultServerUrl === "string" && parsed.defaultServerUrl.trim()
      ? parsed.defaultServerUrl.trim()
      : undefined
  } catch {
    return undefined
  }
}

export function parseDesktopLocalProjects(raw: string): OpenCodeProjectLike[] {
  try {
    const parsed = JSON.parse(raw)
    const serverRaw = parsed?.server
    if (typeof serverRaw !== "string") return []

    const serverState = JSON.parse(serverRaw)
    const localProjects = Array.isArray(serverState?.projects?.local) ? serverState.projects.local : []

    return localProjects
      .map((project: any) => {
        const worktree = typeof project?.worktree === "string" ? project.worktree.trim() : ""
        if (!worktree) return null

        return {
          id: worktree,
          worktree,
          vcs: typeof project?.vcs === "string" ? project.vcs : undefined,
          source: "desktop-local" as const,
        }
      })
      .filter(Boolean) as OpenCodeProjectLike[]
  } catch {
    return []
  }
}

export function readDesktopLocalProjects(homeDir = os.homedir(), platform = process.platform): OpenCodeProjectLike[] {
  const globalStatePath = getDesktopGlobalStatePath(homeDir, platform)
  if (!fs.existsSync(globalStatePath)) return []

  return parseDesktopLocalProjects(fs.readFileSync(globalStatePath, "utf-8"))
}

export function mergeProjectLists(
  backendProjects: OpenCodeProjectLike[],
  desktopProjects: OpenCodeProjectLike[],
): OpenCodeProjectLike[] {
  const merged: OpenCodeProjectLike[] = []
  const seenIds = new Set<string>()
  const seenWorktrees = new Set<string>()

  for (const project of backendProjects) {
    if (!project?.id) continue
    merged.push({ ...project, source: project.source || "backend" })
    seenIds.add(project.id)
    if (typeof project.worktree === "string" && project.worktree.trim()) {
      seenWorktrees.add(path.resolve(project.worktree))
    }
  }

  for (const project of desktopProjects) {
    const worktree = typeof project?.worktree === "string" ? project.worktree.trim() : ""
    if (!project?.id || !worktree) continue

    const resolvedWorktree = path.resolve(worktree)
    if (seenIds.has(project.id) || seenWorktrees.has(resolvedWorktree)) continue

    merged.push({ ...project, worktree, source: "desktop-local" })
    seenIds.add(project.id)
    seenWorktrees.add(resolvedWorktree)
  }

  return merged
}

function readDesktopSettingsBackend(): OpenCodeBackend | null {
  const settingsPath = getDesktopSettingsPath()
  if (!fs.existsSync(settingsPath)) return null

  const raw = fs.readFileSync(settingsPath, "utf-8")
  const url = parseDesktopSettingsServerUrl(raw)
  if (!url) return null

  return {
    baseUrl: url,
    headers: {},
    source: "desktop-default-url",
  }
}

function readDesktopSidecarBackend(): OpenCodeBackend | null {
  const psList = runCommand(["ps", "-axww", "-o", "pid=,command="])
  if (psList.exitCode !== 0) return null

  const pids = parseDesktopSidecarPidList(psList.stdout)
  for (const pid of pids) {
    const details = runCommand(["ps", "eww", "-p", String(pid)])
    if (details.exitCode !== 0) continue

    const backend = parseDesktopSidecarBackend(details.stdout)
    if (backend) return backend
  }

  return null
}

function buildEnvFallbackBackend(): OpenCodeBackend {
  const headers: Record<string, string> = {}
  if (DEFAULT_OPENCODE_PASSWORD) {
    headers.Authorization = buildBasicAuthHeader(DEFAULT_OPENCODE_USERNAME, DEFAULT_OPENCODE_PASSWORD)
  }

  return {
    baseUrl: DEFAULT_OPENCODE_URL,
    headers,
    source: "env",
  }
}

async function checkBackendHealth(backend: OpenCodeBackend) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1500)

  try {
    const response = await fetch(`${backend.baseUrl}/global/health`, {
      method: "GET",
      headers: backend.headers,
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function logBackendSelection(backend: OpenCodeBackend) {
  const authMode = backend.headers.Authorization ? "auth" : "noauth"
  const key = `${backend.source}:${backend.baseUrl}:${authMode}`
  if (key === lastLoggedBackendKey) return

  console.log(`🔌 OpenCode backend: ${backend.source} ${backend.baseUrl}`)
  lastLoggedBackendKey = key
}

export function invalidateOpencodeBackendCache() {
  cachedBackend = null
  cachedBackendAt = 0
}

export async function resolveOpencodeBackend(input?: { forceRefresh?: boolean }) {
  const forceRefresh = input?.forceRefresh === true
  const now = Date.now()

  if (!forceRefresh && cachedBackend && now - cachedBackendAt < BACKEND_CACHE_TTL_MS) {
    return cachedBackend
  }

  const desktopSidecar = readDesktopSidecarBackend()
  if (desktopSidecar && (await checkBackendHealth(desktopSidecar))) {
    cachedBackend = desktopSidecar
    cachedBackendAt = now
    logBackendSelection(desktopSidecar)
    return desktopSidecar
  }

  const desktopDefault = readDesktopSettingsBackend()
  if (desktopDefault && (await checkBackendHealth(desktopDefault))) {
    cachedBackend = desktopDefault
    cachedBackendAt = now
    logBackendSelection(desktopDefault)
    return desktopDefault
  }

  const fallback = buildEnvFallbackBackend()
  cachedBackend = fallback
  cachedBackendAt = now
  logBackendSelection(fallback)
  return fallback
}

function isRetryableFetchError(error: unknown) {
  if (!(error instanceof Error)) return false
  if (error.name === "AbortError") return false

  const message = error.message.toLowerCase()
  return (
    message.includes("fetch failed") ||
    message.includes("failed to fetch") ||
    message.includes("connection refused") ||
    message.includes("econnrefused") ||
    message.includes("socket") ||
    message.includes("network")
  )
}

export async function fetchOpencodePath(
  endpointPath: string,
  init: RequestInit = {},
  input?: { timeoutMs?: number; forceRefresh?: boolean },
): Promise<Response> {
  const forceRefresh = input?.forceRefresh === true
  const timeoutMs = input?.timeoutMs ?? Number(process.env.OPENCODE_REQUEST_TIMEOUT_MS || "8000")
  const backend = await resolveOpencodeBackend({ forceRefresh })
  const headers = new Headers(init.headers || {})

  for (const [key, value] of Object.entries(backend.headers)) {
    if (!headers.has(key)) headers.set(key, value)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`${backend.baseUrl}${endpointPath}`, {
      ...init,
      headers,
      signal: controller.signal,
    })

    if (!forceRefresh && (response.status === 401 || response.status === 403)) {
      invalidateOpencodeBackendCache()
      return fetchOpencodePath(endpointPath, init, { timeoutMs, forceRefresh: true })
    }

    return response
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error(`${init.method || "GET"} ${endpointPath} timed out after ${timeoutMs}ms`)
    }

    if (!forceRefresh && isRetryableFetchError(error)) {
      invalidateOpencodeBackendCache()
      return fetchOpencodePath(endpointPath, init, { timeoutMs, forceRefresh: true })
    }

    throw error
  } finally {
    clearTimeout(timer)
  }
}
