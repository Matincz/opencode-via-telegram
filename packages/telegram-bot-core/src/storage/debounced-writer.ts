import { writeJsonFile } from "./json"

export function createDebouncedJsonWriter(filePath: string, delayMs = 300) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pendingValue: unknown = undefined
  let hasPending = false

  function schedule(value: unknown) {
    pendingValue = value
    hasPending = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (!hasPending) return
      hasPending = false
      try {
        writeJsonFile(filePath, pendingValue)
      } catch (error) {
        console.error(`debounced write failed for ${filePath}:`, error)
      }
    }, delayMs)
  }

  function flush() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!hasPending) return
    hasPending = false
    try {
      writeJsonFile(filePath, pendingValue)
    } catch (error) {
      console.error(`debounced flush failed for ${filePath}:`, error)
    }
  }

  return { schedule, flush }
}
