import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CircuitBreaker, type CircuitBreakerConfig } from '../src/core/circuit-breaker.js';

function makeConfig(overrides: Partial<CircuitBreakerConfig> = {}): CircuitBreakerConfig {
  return {
    noProgressThreshold: 3,
    sameErrorThreshold: 4,
    costPerIterationThreshold: 5.0,
    cooldownMinutes: 15,
    ...overrides,
  };
}

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker(makeConfig());
  });

  it('starts closed', () => {
    expect(cb.getState()).toBe('closed');
    expect(cb.isTerminal()).toBe(false);
  });

  it('trips to open after N no-progress iterations', () => {
    for (let i = 0; i < 3; i++) {
      cb.recordIteration({ madeProgress: false });
    }
    expect(cb.getState()).toBe('open');
    expect(cb.isTerminal()).toBe(true);
  });

  it('does not trip before threshold', () => {
    cb.recordIteration({ madeProgress: false });
    cb.recordIteration({ madeProgress: false });
    expect(cb.getState()).toBe('closed');
  });

  it('resets no-progress counter on progress', () => {
    cb.recordIteration({ madeProgress: false });
    cb.recordIteration({ madeProgress: false });
    cb.recordIteration({ madeProgress: true });
    cb.recordIteration({ madeProgress: false });
    cb.recordIteration({ madeProgress: false });
    expect(cb.getState()).toBe('closed');
  });

  it('trips on same error repeated N times', () => {
    for (let i = 0; i < 4; i++) {
      cb.recordIteration({ madeProgress: false, error: 'SyntaxError: unexpected token' });
    }
    expect(cb.getState()).toBe('open');
  });

  it('resets same-error counter on different error', () => {
    // Use higher no-progress threshold so we only test same-error logic
    const cb2 = new CircuitBreaker(makeConfig({ noProgressThreshold: 10, sameErrorThreshold: 4 }));
    cb2.recordIteration({ madeProgress: false, error: 'Error A' });
    cb2.recordIteration({ madeProgress: false, error: 'Error A' });
    cb2.recordIteration({ madeProgress: false, error: 'Error A' });
    cb2.recordIteration({ madeProgress: false, error: 'Error B' });
    // Same-error counter reset to 1 for Error B, not tripped
    expect(cb2.getState()).toBe('closed');
  });

  it('trips on cost spike above threshold', () => {
    cb.recordIteration({ madeProgress: true, costUsd: 6.0 });
    expect(cb.getState()).toBe('open');
  });

  it('does not trip on cost below threshold', () => {
    cb.recordIteration({ madeProgress: true, costUsd: 4.99 });
    expect(cb.getState()).toBe('closed');
  });

  it('transitions to half_open after cooldown', () => {
    cb.recordIteration({ madeProgress: false });
    cb.recordIteration({ madeProgress: false });
    cb.recordIteration({ madeProgress: false });
    expect(cb.getState()).toBe('open');

    // Simulate time passing beyond cooldown
    cb.advanceClock(16 * 60 * 1000); // 16 minutes
    cb.tryHalfOpen();
    expect(cb.getState()).toBe('half_open');
  });

  it('does not transition to half_open before cooldown', () => {
    cb.recordIteration({ madeProgress: false });
    cb.recordIteration({ madeProgress: false });
    cb.recordIteration({ madeProgress: false });

    cb.advanceClock(5 * 60 * 1000); // only 5 minutes
    cb.tryHalfOpen();
    expect(cb.getState()).toBe('open');
  });

  it('returns to closed on successful iteration in half_open', () => {
    cb.recordIteration({ madeProgress: false });
    cb.recordIteration({ madeProgress: false });
    cb.recordIteration({ madeProgress: false });

    cb.advanceClock(16 * 60 * 1000);
    cb.tryHalfOpen();
    expect(cb.getState()).toBe('half_open');

    cb.recordIteration({ madeProgress: true });
    expect(cb.getState()).toBe('closed');
  });

  it('returns to open on failed iteration in half_open', () => {
    cb.recordIteration({ madeProgress: false });
    cb.recordIteration({ madeProgress: false });
    cb.recordIteration({ madeProgress: false });

    cb.advanceClock(16 * 60 * 1000);
    cb.tryHalfOpen();

    cb.recordIteration({ madeProgress: false });
    expect(cb.getState()).toBe('open');
  });

  it('isTerminal returns true when open and cooldown not elapsed', () => {
    cb.recordIteration({ madeProgress: false });
    cb.recordIteration({ madeProgress: false });
    cb.recordIteration({ madeProgress: false });
    expect(cb.isTerminal()).toBe(true);
  });

  it('isTerminal returns false when half_open', () => {
    cb.recordIteration({ madeProgress: false });
    cb.recordIteration({ madeProgress: false });
    cb.recordIteration({ madeProgress: false });
    cb.advanceClock(16 * 60 * 1000);
    cb.tryHalfOpen();
    expect(cb.isTerminal()).toBe(false);
  });

  it('reset clears all counters', () => {
    cb.recordIteration({ madeProgress: false });
    cb.recordIteration({ madeProgress: false });
    cb.reset();
    cb.recordIteration({ madeProgress: false });
    cb.recordIteration({ madeProgress: false });
    // Should not trip — was reset
    expect(cb.getState()).toBe('closed');
  });

  it('no-progress counter tracks iterations without progress regardless of error', () => {
    // 3 no-progress iterations (some with errors, some without) should trip
    cb.recordIteration({ madeProgress: false });
    cb.recordIteration({ madeProgress: false, error: 'some error' });
    cb.recordIteration({ madeProgress: false });
    expect(cb.getState()).toBe('open');
  });
});
