import { logger } from "./logger.js";

type State = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  name:              string;
  timeout:           number;
  errorThresholdPct: number;
  resetTimeout:      number;
  volumeThreshold:   number;
}

export class CircuitBreaker {
  private state:         State  = "CLOSED";
  private failures:      number = 0;
  private successes:     number = 0;
  private lastFailureAt: number = 0;

  constructor(private readonly opts: CircuitBreakerOptions) {}

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      if (Date.now() - this.lastFailureAt > this.opts.resetTimeout) {
        this.state = "HALF_OPEN";
        logger.info(`CircuitBreaker[${this.opts.name}] → HALF_OPEN`);
      } else {
        throw new Error(`${this.opts.name} is currently unavailable. Please retry shortly.`);
      }
    }

    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`${this.opts.name} timed out after ${this.opts.timeout}ms`)),
            this.opts.timeout,
          ),
        ),
      ]);
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.failures  = 0;
    this.successes = 0;
    if (this.state === "HALF_OPEN") {
      this.state = "CLOSED";
      logger.info(`CircuitBreaker[${this.opts.name}] → CLOSED`);
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureAt = Date.now();
    const total = this.failures + this.successes;
    const pct   = total >= this.opts.volumeThreshold
      ? (this.failures / total) * 100
      : 0;
    if (pct >= this.opts.errorThresholdPct) {
      this.state = "OPEN";
      logger.warn(`CircuitBreaker[${this.opts.name}] → OPEN`, { failures: this.failures });
    }
  }

  getState(): State { return this.state; }
}
