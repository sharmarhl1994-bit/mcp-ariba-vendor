import { logger } from "./logger.js";

interface Slot { count: number; windowStart: number }

export class RateLimiter {
  private slot: Slot = { count: 0, windowStart: Date.now() };

  constructor(private readonly maxPerMinute: number) {}

  async acquire(): Promise<void> {
    const now      = Date.now();
    const elapsed  = now - this.slot.windowStart;

    if (elapsed >= 60_000) {
      this.slot = { count: 0, windowStart: now };
    }

    if (this.slot.count >= this.maxPerMinute) {
      const waitMs = 60_000 - elapsed + 100;
      logger.warn("Rate limit reached — waiting", { waitMs, maxPerMinute: this.maxPerMinute });
      await new Promise(r => setTimeout(r, waitMs));
      this.slot = { count: 0, windowStart: Date.now() };
    }

    this.slot.count++;
  }
}
