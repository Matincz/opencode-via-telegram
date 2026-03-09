import * as fs from "fs"

interface LockFileContent {
  pid: number
  createdAt: string
  cwd: string
}

export class SingleInstanceLockError extends Error {
  readonly lockPath: string
  readonly existingPid?: number

  constructor(lockPath: string, existingPid?: number) {
    super(
      existingPid
        ? `another process already owns ${lockPath} (pid ${existingPid})`
        : `another process already owns ${lockPath}`,
    )
    this.name = "SingleInstanceLockError"
    this.lockPath = lockPath
    this.existingPid = existingPid
  }
}

function readLockFile(lockPath: string): LockFileContent | undefined {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8").trim()
    if (!raw) return undefined

    const parsed = JSON.parse(raw)
    if (typeof parsed?.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return undefined
    }

    return {
      pid: parsed.pid,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
    }
  } catch {
    return undefined
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: any) {
    return error?.code === "EPERM"
  }
}

export function acquireSingleInstanceLock(lockPath: string, pid = process.pid): { release: () => void } {
  let acquired = false

  const tryAcquire = () => {
    const fd = fs.openSync(lockPath, "wx")
    const payload: LockFileContent = {
      pid,
      createdAt: new Date().toISOString(),
      cwd: process.cwd(),
    }
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2), "utf-8")
    fs.closeSync(fd)
    acquired = true
  }

  try {
    tryAcquire()
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error

    const existing = readLockFile(lockPath)
    if (existing?.pid && existing.pid !== pid && isProcessRunning(existing.pid)) {
      throw new SingleInstanceLockError(lockPath, existing.pid)
    }

    fs.rmSync(lockPath, { force: true })
    tryAcquire()
  }

  return {
    release: () => {
      if (!acquired) return
      acquired = false

      const existing = readLockFile(lockPath)
      if (existing?.pid && existing.pid !== pid) return

      fs.rmSync(lockPath, { force: true })
    },
  }
}
