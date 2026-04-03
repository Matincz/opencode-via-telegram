import { describe, expect, it } from "bun:test"
import { TelegramMediaGroupBuffer } from "./media-group-buffer"

describe("TelegramMediaGroupBuffer", () => {
  it("flushes grouped items together once", async () => {
    const buffer = new TelegramMediaGroupBuffer<number>(20)
    const flushed: number[][] = []

    buffer.enqueue("chat:group", 1, async (items) => {
      flushed.push(items)
    })
    buffer.enqueue("chat:group", 2, async (items) => {
      flushed.push(items)
    })

    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(flushed).toEqual([[1, 2]])
  })
})
