/** Log severity levels */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_VALUES: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let _globalLevel: LogLevel = 'info';

/** Sets the global minimum log level shared by all logger instances */
export function setLogLevel(level: LogLevel): void {
  _globalLevel = level;
}

/** Creates a named logger scoped to a module */
export function createLogger(name: string): Logger {
  return new Logger(name);
}

/** Structured logger with named context and global-level filtering */
export class Logger {
  constructor(private readonly name: string) {}

  /** Logs at debug level */
  debug(msg: string, ...args: unknown[]): void { this.log('debug', msg, ...args); }
  /** Logs at info level */
  info(msg: string, ...args: unknown[]): void { this.log('info', msg, ...args); }
  /** Logs at warn level */
  warn(msg: string, ...args: unknown[]): void { this.log('warn', msg, ...args); }
  /** Logs at error level */
  error(msg: string, ...args: unknown[]): void { this.log('error', msg, ...args); }

  private log(level: LogLevel, msg: string, ...args: unknown[]): void {
    if (LEVEL_VALUES[level] < LEVEL_VALUES[_globalLevel]) return;
    const ts = new Date().toISOString();
    const out = `[${ts}] [${level.toUpperCase().padEnd(5)}] [${this.name.padEnd(16)}] ${msg}`;
    if (level === 'error') console.error(out, ...args);
    else if (level === 'warn') console.warn(out, ...args);
    else console.log(out, ...args);
  }
}
