import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SignalHandler } from '../src/core/signal-handler.js';

describe('SignalHandler', () => {
  let handler: SignalHandler;

  beforeEach(() => {
    handler = new SignalHandler();
  });

  afterEach(() => {
    handler.unregister();
  });

  it('isStopRequested is false after creation', () => {
    expect(handler.isStopRequested()).toBe(false);
  });

  it('sets isStopRequested to true on first signal', () => {
    handler.register();
    handler.handleSignal('SIGINT');
    expect(handler.isStopRequested()).toBe(true);
  });

  it('invokes onStop callback on first signal', () => {
    const callback = vi.fn();
    handler.onStop(callback);
    handler.register();
    handler.handleSignal('SIGINT');
    expect(callback).toHaveBeenCalledOnce();
  });

  it('calls forceExit on second signal', () => {
    const forceExit = vi.fn();
    handler.onForceExit(forceExit);
    handler.register();
    handler.handleSignal('SIGINT');
    handler.handleSignal('SIGINT');
    expect(forceExit).toHaveBeenCalledOnce();
  });
});
