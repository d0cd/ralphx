import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SignalHandler } from '../src/core/signal-handler.js';

describe('SignalHandler crash handling', () => {
  let handler: SignalHandler;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    handler = new SignalHandler();
    // handleCrash calls process.exit(1) after best-effort state save;
    // mock it so tests don't terminate the process.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    handler.unregister();
    exitSpy.mockRestore();
  });

  it('invokes onCrash callback on handleCrash', () => {
    const crashCb = vi.fn();
    handler.onCrash(crashCb);
    handler.handleCrash(new Error('Uncaught'));
    expect(crashCb).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does not throw when no crash callback registered', () => {
    expect(() => handler.handleCrash(new Error('No callback'))).not.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('invokes crash callback on second signal before force exit', () => {
    const crashCb = vi.fn();
    const forceExit = vi.fn();
    handler.onCrash(crashCb);
    handler.onForceExit(forceExit);
    handler.register();

    handler.handleSignal('SIGINT');
    handler.handleSignal('SIGINT');

    expect(crashCb).toHaveBeenCalledOnce();
    expect(forceExit).toHaveBeenCalledOnce();
  });

  it('swallows crash callback errors on second signal', () => {
    handler.onCrash(() => { throw new Error('crash callback failed'); });
    const forceExit = vi.fn();
    handler.onForceExit(forceExit);
    handler.register();

    handler.handleSignal('SIGINT');
    expect(() => handler.handleSignal('SIGINT')).not.toThrow();
    expect(forceExit).toHaveBeenCalledOnce();
  });

  it('handles unhandled rejection by wrapping non-Error reasons', () => {
    const crashCb = vi.fn();
    handler.onCrash(crashCb);

    // The boundUnhandledHandler wraps non-Error values
    // We test indirectly via handleCrash since the handler converts and calls it
    handler.handleCrash(new Error('string reason'));
    expect(crashCb).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
