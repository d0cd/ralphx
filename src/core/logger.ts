type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function formatMessage(level: LogLevel, msg: string): string {
  const ts = new Date().toISOString();
  return `[${ts}] [${level.toUpperCase()}] ${msg}`;
}

export const log = {
  debug(msg: string): void {
    if (shouldLog('debug')) console.debug(formatMessage('debug', msg));
  },
  info(msg: string): void {
    if (shouldLog('info')) console.log(formatMessage('info', msg));
  },
  warn(msg: string): void {
    if (shouldLog('warn')) console.warn(formatMessage('warn', msg));
  },
  error(msg: string): void {
    if (shouldLog('error')) console.error(formatMessage('error', msg));
  },
};
