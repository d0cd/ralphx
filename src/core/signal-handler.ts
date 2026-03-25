export class SignalHandler {
  private stopRequested = false;
  private signalCount = 0;
  private stopCallback?: () => void;
  private forceExitCallback?: () => void;
  private crashCallback?: () => void;
  private boundHandler: (signal: string) => void;
  private boundUncaughtHandler: (err: Error) => void;
  private boundUnhandledHandler: (reason: unknown) => void;

  constructor() {
    this.boundHandler = (signal: string) => this.handleSignal(signal);
    this.boundUncaughtHandler = (err: Error) => this.handleCrash(err);
    this.boundUnhandledHandler = (reason: unknown) => {
      const err = reason instanceof Error ? reason : new Error(String(reason));
      this.handleCrash(err);
    };
  }

  register(): void {
    process.on('SIGINT', () => this.boundHandler('SIGINT'));
    process.on('SIGTERM', () => this.boundHandler('SIGTERM'));
    process.on('uncaughtException', this.boundUncaughtHandler);
    process.on('unhandledRejection', this.boundUnhandledHandler);
  }

  unregister(): void {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    process.removeListener('uncaughtException', this.boundUncaughtHandler);
    process.removeListener('unhandledRejection', this.boundUnhandledHandler);
  }

  handleSignal(_signal: string): void {
    this.signalCount++;
    if (this.signalCount === 1) {
      this.stopRequested = true;
      this.stopCallback?.();
    } else {
      // Second signal: best-effort crash status, then force exit
      try { this.crashCallback?.(); } catch { /* best effort */ }
      this.forceExitCallback?.();
    }
  }

  /** Handle uncaught exceptions / unhandled rejections with best-effort state save */
  handleCrash(_err: Error): void {
    try { this.crashCallback?.(); } catch { /* best effort */ }
  }

  isStopRequested(): boolean {
    return this.stopRequested;
  }

  onStop(callback: () => void): void {
    this.stopCallback = callback;
  }

  onForceExit(callback: () => void): void {
    this.forceExitCallback = callback;
  }

  /** Register a callback for best-effort state persistence on crash paths */
  onCrash(callback: () => void): void {
    this.crashCallback = callback;
  }
}
