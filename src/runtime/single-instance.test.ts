import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { acquireSingleInstanceLock, SingleInstanceLockError } from "./single-instance"

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function makeLockPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "single-instance-lock-"))
  tempDirs.push(dir)
  return path.join(dir, "bridge.lock")
}

describe("acquireSingleInstanceLock", () => {
  it("creates and releases the lock file", () => {
    const lockPath = makeLockPath()
    const lock = acquireSingleInstanceLock(lockPath)

    expect(fs.existsSync(lockPath)).toBe(true)

    lock.release()

    expect(fs.existsSync(lockPath)).toBe(false)
  })

  it("replaces a stale lock file", () => {
    const lockPath = makeLockPath()
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999, createdAt: "2026-03-08T00:00:00.000Z", cwd: "/tmp" }),
      "utf-8",
    )

    const lock = acquireSingleInstanceLock(lockPath)
    const content = JSON.parse(fs.readFileSync(lockPath, "utf-8"))

    expect(content.pid).toBe(process.pid)

    lock.release()
  })

  it("throws when another live process owns the lock", () => {
    const lockPath = makeLockPath()
    const firstLock = acquireSingleInstanceLock(lockPath, process.pid)

    expect(() => acquireSingleInstanceLock(lockPath, process.pid + 1)).toThrow(SingleInstanceLockError)

    firstLock.release()
  })
})
