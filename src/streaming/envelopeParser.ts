import { EventEmitter } from 'events';
import { type EnvelopeMessage, type EnvelopeType } from '../types.js';
import { createLogger } from '../utils/logger.js';
import { stripAnsi } from './ansiStrip.js';

const logger = createLogger('EnvelopeParser');

/** Regex for the envelope open tag — case-insensitive */
const OPEN_TAG_RE = /<<<slack(?::(\w+))?>>>/i;
/** Lowercase close tag (compared case-insensitively at runtime) */
const CLOSE_TAG = '<<<end_slack>>>';
/** Tail kept in scanBuffer to catch tags split across PTY chunks */
const SCAN_TAIL = 40;

const VALID_TYPES = new Set(['progress', 'question', 'warning', 'done', 'error']);

export interface EnvelopeParserOptions {
  /** ms of silence after creation before the parser starts scanning (skips PTY echo) */
  activationDelayMs: number;
  /** ms in CAPTURING state before a partial envelope is force-flushed */
  unclosedTimeoutMs: number;
}

/**
 * Stateful stream parser that extracts <<<SLACK>>>…<<<END_SLACK>>> envelopes
 * from a PTY data stream and emits them as 'envelope' events.
 *
 * Handles:
 *   - Markers split across arbitrary chunk boundaries
 *   - PTY echo of the injected system prompt (activation delay)
 *   - Unclosed-envelope safety flush after a configurable timeout
 */
export class EnvelopeParser extends EventEmitter {
  private state: 'scanning' | 'capturing' = 'scanning';
  private scanBuffer = '';
  private captureBuffer = '';
  private currentType: EnvelopeType | null = null;
  private activated = false;
  private readonly activationTimer: ReturnType<typeof setTimeout>;
  private unclosedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: EnvelopeParserOptions) {
    super();
    this.activationTimer = setTimeout(() => {
      this.activated = true;
      logger.debug('Envelope parser activated');
    }, opts.activationDelayMs);
  }

  /**
   * Feeds a raw PTY data chunk into the parser.
   * Must be called for every chunk, in order — the parser is stateful.
   */
  push(data: string): void {
    if (!this.activated) {
      logger.debug('push: NOT ACTIVATED, dropping %d bytes', data.length);
      return;
    }
    logger.debug('push: %d bytes, state=%s, scanBuf=%d', data.length, this.state, this.scanBuffer.length);

    if (this.state === 'scanning') {
      this.scanBuffer += data;
      this.tryScanOpen();
    } else {
      this.captureBuffer += data;
      this.tryClose();
    }
  }

  /**
   * Flushes any in-progress capture as an incomplete envelope and
   * stops all internal timers.  Call when the parent process exits.
   */
  flush(): void {
    clearTimeout(this.activationTimer);
    if (this.unclosedTimer) clearTimeout(this.unclosedTimer);

    if (this.state === 'capturing' && this.captureBuffer.trim()) {
      logger.warn('Flushing incomplete envelope on process exit');
      this.emit('envelope', {
        type: this.currentType,
        text: stripAnsi(this.captureBuffer).trim(),
        incomplete: true,
      } as EnvelopeMessage);
    }
    this.reset();
  }

  /** Searches scanBuffer for an open tag; transitions to CAPTURING on match */
  private tryScanOpen(): void {
    const match = OPEN_TAG_RE.exec(this.scanBuffer);
    if (!match) {
      // Trim to avoid unbounded growth; keep enough to detect a split tag
      if (this.scanBuffer.length > SCAN_TAIL) {
        this.scanBuffer = this.scanBuffer.slice(-SCAN_TAIL);
      }
      return;
    }

    const rawType = match[1]?.toLowerCase();
    this.currentType = rawType && VALID_TYPES.has(rawType) ? (rawType as EnvelopeType) : null;
    this.captureBuffer = this.scanBuffer.slice(match.index! + match[0].length);
    this.scanBuffer = '';
    this.state = 'capturing';
    logger.debug('Envelope open tag found, type=%s', this.currentType);

    // Safety timer: force-flush if close tag never arrives
    this.unclosedTimer = setTimeout(() => this.flushPartial(), this.opts.unclosedTimeoutMs);

    // Close tag may already be in the captured remainder
    this.tryClose();
  }

  /** Searches captureBuffer for the close tag; emits 'envelope' on match */
  private tryClose(): void {
    const idx = this.captureBuffer.toLowerCase().indexOf(CLOSE_TAG);
    if (idx === -1) return;

    if (this.unclosedTimer) {
      clearTimeout(this.unclosedTimer);
      this.unclosedTimer = null;
    }

    const text      = stripAnsi(this.captureBuffer.slice(0, idx)).trim();
    const remainder = this.captureBuffer.slice(idx + CLOSE_TAG.length);

    this.emit('envelope', { type: this.currentType, text } as EnvelopeMessage);
    logger.debug('Envelope closed, type=%s, %d chars', this.currentType, text.length);

    // Remainder may contain another open tag — feed it back into scanning
    this.state = 'scanning';
    this.captureBuffer = '';
    this.scanBuffer = remainder;
    if (remainder.length > 0) this.tryScanOpen();
  }

  /** Flushes partial content when the unclosed-timeout fires */
  private flushPartial(): void {
    logger.warn('Unclosed envelope timeout; flushing %d chars', this.captureBuffer.length);
    const text = stripAnsi(this.captureBuffer).trim();
    if (text) {
      this.emit('envelope', { type: this.currentType, text, incomplete: true } as EnvelopeMessage);
    }
    this.state = 'scanning';
    this.captureBuffer = '';
  }

  /** Resets all mutable state */
  private reset(): void {
    this.state = 'scanning';
    this.scanBuffer = '';
    this.captureBuffer = '';
    this.currentType = null;
  }
}
