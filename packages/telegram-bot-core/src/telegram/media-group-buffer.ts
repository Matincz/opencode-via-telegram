export class TelegramMediaGroupBuffer<T> {
  private readonly entries = new Map<string, { items: T[]; timer: ReturnType<typeof setTimeout> }>()

  constructor(private readonly delayMs = 350) {}

  enqueue(key: string, item: T, onFlush: (items: T[]) => void | Promise<void>) {
    const current = this.entries.get(key)
    if (current) {
      current.items.push(item)
      clearTimeout(current.timer)
      current.timer = this.createTimer(key, onFlush)
      return
    }

    this.entries.set(key, {
      items: [item],
      timer: this.createTimer(key, onFlush),
    })
  }

  private createTimer(key: string, onFlush: (items: T[]) => void | Promise<void>) {
    return setTimeout(async () => {
      const entry = this.entries.get(key)
      if (!entry) return
      this.entries.delete(key)
      await onFlush(entry.items)
    }, this.delayMs)
  }
}
