declare module "croner" {
  export class Cron {
    constructor(pattern: string, fn: () => void | Promise<void>)
    stop(): void
  }
}
