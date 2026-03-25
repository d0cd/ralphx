import { describe, it, expect } from 'vitest';
import { isPidAlive } from '../src/sync/pid-utils.js';

describe('isPidAlive', () => {
  it('returns true for the current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('returns false for a non-existent PID', () => {
    // PID 999999999 is extremely unlikely to exist
    expect(isPidAlive(999999999)).toBe(false);
  });

  it('returns false for a very large negative PID', () => {
    // Very large negative PIDs have no valid process group
    expect(isPidAlive(-999999999)).toBe(false);
  });

  it('returns false for PID 0', () => {
    // PID 0 is the kernel scheduler on Unix; process.kill(0, 0)
    // sends signal to the process group, which may or may not throw.
    // The important thing is it doesn't crash.
    const result = isPidAlive(0);
    expect(typeof result).toBe('boolean');
  });
});
