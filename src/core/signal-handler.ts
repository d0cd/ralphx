export class SignalHandler {
  private signalCount = 0;
  private stopCallback?: () => void;
  private forceExitCallback?: () => void;
  private crashCallback?: () => void;
  private boundSigintHandler: () => void;
  private boundSigtermHandler: () => void;
  private boundUncaughtHandler: (err: Error) => void;
  private boundUnhandledHandler: (reason: unknown) => void;

  constructor() {
    this.boundSigintHandler = () => this.handleSignal('SIGINT');
    this.boundSigtermHandler = () => this.handleSignal('SIGTERM');
    this.boundUncaughtHandler = (err: Error) => this.handleCrash(err);
    this.boundUnhandledHandler = (reason: unknown) => {
      this.handleCrash(new Error(reason instanceof Error ? reason.message : String(reason)));
    };
  }

  register(): void {
    process.on('SIGINT', this.boundSigintHandler);
    process.on('SIGTERM', this.boundSigtermHandler);
    process.on('uncaughtException', this.boundUncaughtHandler);
    process.on('unhandledRejection', this.boundUnhandledHandler);
  }

  unregister(): void {
    process.removeListener('SIGINT', this.boundSigintHandler);
    process.removeListener('SIGTERM', this.boundSigtermHandler);
    process.removeListener('uncaughtException', this.boundUncaughtHandler);
    process.removeListener('unhandledRejection', this.boundUnhandledHandler);
  }

  handleSignal(_signal: string): void {
    this.signalCount++;
    if (this.signalCount === 1) {
      this.stopCallback?.();
    } else {
      // Second signal: best-effort crash status, then force exit
      try { this.crashCallback?.(); } catch { /* best effort */ }
      this.forceExitCallback?.();
    }
  }

  /** Handle uncaught exceptions / unhandled rejections with best-effort state save */
  handleCrash(err: Error): void {
    try { this.crashCallback?.(); } catch { /* best effort */ }
    // After best-effort state save, exit with error code.
    // Without this, uncaughtException handlers swallow the error and the
    // process hangs (Node.js expects the process to exit after an
    // uncaughtException handler runs).
    console.error(`[ralphx] Fatal: ${err.message}`);
    process.exit(1);
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
