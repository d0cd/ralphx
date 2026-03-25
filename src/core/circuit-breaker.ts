type CircuitBreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  noProgressThreshold: number;
  sameErrorThreshold: number;
  costPerIterationThreshold?: number;
  cooldownMinutes: number;
}

interface IterationOutcome {
  madeProgress: boolean;
  error?: string;
  costUsd?: number;
  validationFailed?: boolean;
}

export class CircuitBreaker {
  private state: CircuitBreakerState = 'closed';
  private config: CircuitBreakerConfig;
  private noProgressCount = 0;
  private sameErrorCount = 0;
  private lastError: string | null = null;
  private openedAt: number | null = null;
  private clockOffset = 0; // for testing

  constructor(config: CircuitBreakerConfig) {
    this.config = config;
  }

  getState(): CircuitBreakerState {
    return this.state;
  }

  isTerminal(): boolean {
    return this.state === 'open';
  }

  recordIteration(outcome: IterationOutcome): void {
    // Cost spike check
    if (
      this.config.costPerIterationThreshold !== undefined &&
      outcome.costUsd !== undefined &&
      outcome.costUsd > this.config.costPerIterationThreshold
    ) {
      this.trip();
      return;
    }

    if (outcome.madeProgress) {
      this.noProgressCount = 0;
      this.sameErrorCount = 0;
      this.lastError = null;

      // Half-open → closed on success
      if (this.state === 'half_open') {
        this.state = 'closed';
      }
      return;
    }

    // No progress
    this.noProgressCount++;

    // Same error tracking
    if (outcome.error) {
      if (outcome.error === this.lastError) {
        this.sameErrorCount++;
      } else {
        this.lastError = outcome.error;
        this.sameErrorCount = 1;
      }
    } else {
      // No error breaks the consecutive same-error streak
      this.sameErrorCount = 0;
      this.lastError = null;
    }

    // Check trip conditions
    if (this.noProgressCount >= this.config.noProgressThreshold) {
      this.trip();
      return;
    }

    if (this.sameErrorCount >= this.config.sameErrorThreshold) {
      this.trip();
      return;
    }

    // Half-open → open on failure
    if (this.state === 'half_open') {
      this.trip();
    }
  }

  tryHalfOpen(): void {
    if (this.state !== 'open' || this.openedAt === null) return;
    const now = Date.now() + this.clockOffset;
    const elapsed = now - this.openedAt;
    if (elapsed >= this.config.cooldownMinutes * 60 * 1000) {
      this.state = 'half_open';
    }
  }

  reset(): void {
    this.state = 'closed';
    this.noProgressCount = 0;
    this.sameErrorCount = 0;
    this.lastError = null;
    this.openedAt = null;
  }

  /** For testing: simulate time passing */
  advanceClock(ms: number): void {
    this.clockOffset += ms;
  }

  private trip(): void {
    this.state = 'open';
    this.openedAt = Date.now() + this.clockOffset;
  }
}
