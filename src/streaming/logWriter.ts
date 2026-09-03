import { createWriteStream, mkdirSync, existsSync, type WriteStream } from 'fs';
import { resolve } from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('LogWriter');

/**
 * Persists the raw, unfiltered PTY output for a single session to disk.
 * Log files are written to logs/sessions/<sessionId>.log — no ANSI stripping
 * is applied so the log is a faithful record of terminal output.
 */
export class LogWriter {
  /** Absolute path to this session's log file */
  readonly logPath: string;
  private stream: WriteStream | null = null;

  constructor(sessionId: string) {
    const dir = resolve(process.cwd(), 'logs', 'sessions');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.logPath = resolve(dir, `${sessionId}.log`);
  }

  /** Opens the write stream and writes a session-start header */
  open(): void {
    this.stream = createWriteStream(this.logPath, { flags: 'a', encoding: 'utf-8' });
    this.stream.write(`=== Session started: ${new Date().toISOString()} ===\n`);
  }

  /** Writes a raw PTY data chunk (ANSI codes preserved) */
  write(data: string): void {
    this.stream?.write(data);
  }

  /**
   * Writes a footer with exit metadata and closes the stream.
   * Resolves only once the data is actually flushed to disk — callers that
   * read the file back immediately after (tests, /logs) would otherwise
   * race a write stream that has been told to end but hasn't finished yet.
   * @param exitCode Process exit code; -1 indicates timeout
   */
  close(exitCode: number): Promise<void> {
    const stream = this.stream;
    if (!stream) return Promise.resolve();
    this.stream = null;
    return new Promise((resolve) => {
      stream.end(`\n=== Session ended: ${new Date().toISOString()} | exit code: ${exitCode} ===\n`, () => {
        logger.debug('Log closed: %s', this.logPath);
        resolve();
      });
    });
  }
}
