import { type EnvelopeMessage } from '../types.js';
import { type SlackReporter } from '../slack/reporter.js';
import { createLogger } from '../utils/logger.js';
import { markdownToSlack } from '../utils/slackFormat.js';
import { LogWriter } from './logWriter.js';
import { EnvelopeParser } from './envelopeParser.js';
import { FullStreamer } from './fullStreamer.js';

const logger = createLogger('OutputRouter');

/** Emoji prefix for each envelope type */
const ENVELOPE_PREFIX: Record<string, string> = {
  progress: '🔄 ',
  question: '🤔 ',
  warning:  '⚠️ ',
  done:     '✅ ',
  error:    '❌ ',
};

export interface OutputRouterOptions {
  sessionId: string;
  channelId: string;
  threadTs: string;
  /** true → envelope mode; false → full-output mode */
  envelope: boolean;
  /**
   * When 'json', the router runs in *capture mode*: nothing is streamed to
   * Slack; stdout is buffered verbatim for a caller to parse after exit.
   * Deliberately generic (not mail-specific) so any future JSON-output job
   * type can reuse the same seam.
   */
  outputFormat?: string;
  reporter: SlackReporter;
  envelopeConfig: { activationDelayMs: number; unclosedTimeoutMs: number };
  streamConfig:   { flushIntervalMs: number; maxCharsPerMessage: number };
}

/**
 * Per-session output router implementing the two-track model:
 *   Track 1 – LogWriter       (always receives every raw byte)
 *   Track 2 – Slack channel   (EnvelopeParser OR FullStreamer depending on mode)
 */
export class OutputRouter {
  /** Exposed so the runner can read the log path for /logs */
  readonly logWriter: LogWriter;
  private parser:   EnvelopeParser | null = null;
  private streamer: FullStreamer  | null = null;
  /** Capture mode only: buffered stdout, fed via captureStdout() */
  private captureBuffer = '';
  /** True when this router is in capture mode (outputFormat === 'json') */
  readonly capture: boolean;

  constructor(private readonly opts: OutputRouterOptions) {
    this.logWriter = new LogWriter(opts.sessionId);
    this.capture   = opts.outputFormat === 'json';

    if (this.capture) {
      // Capture mode: no Slack track at all — Track 1 (log) still gets everything.
    } else if (opts.envelope) {
      this.parser = new EnvelopeParser(opts.envelopeConfig);
      this.parser.on('envelope', (msg: EnvelopeMessage) => void this.onEnvelope(msg));
    } else {
      this.streamer = new FullStreamer({
        reporter:           opts.reporter,
        channelId:          opts.channelId,
        threadTs:           opts.threadTs,
        flushIntervalMs:    opts.streamConfig.flushIntervalMs,
        maxCharsPerMessage: opts.streamConfig.maxCharsPerMessage,
      });
    }
  }

  /** Opens the log and starts the streamer (no-op for envelope mode) */
  async start(): Promise<void> {
    this.logWriter.open();
    if (this.streamer) await this.streamer.start();
  }

  /**
   * Pushes a raw PTY data chunk through both output tracks.
   * Track 1 always receives the data; Track 2 filters or buffers it.
   */
  push(data: string): void {
    this.logWriter.write(data);   // Track 1 – always
    this.parser?.push(data);      // Track 2a – envelope mode
    this.streamer?.push(data);    // Track 2b – full-output mode
    // Track 2c – capture mode: nothing here on purpose. Capture-mode stdout
    // arrives via captureStdout() from a stdout-only source, so stderr that
    // reaches push() is logged but never enters the JSON buffer.
  }

  /**
   * Capture mode only: appends a stdout-only chunk to the JSON buffer.
   * Callers must NOT route stderr here.
   */
  captureStdout(data: string): void {
    if (!this.capture) return;
    this.captureBuffer += data;
  }

  /** Capture mode only: the raw buffered stdout collected so far. */
  getCapturedStdout(): string {
    return this.captureBuffer;
  }

  /**
   * Finalises both tracks: flushes partial envelopes, posts exit status,
   * and closes the log file.
   * @param exitCode Process exit code
   */
  async finish(exitCode: number): Promise<void> {
    logger.debug('OutputRouter.finish() called with exitCode=%d', exitCode);
    try {
      this.parser?.flush();
      logger.debug('OutputRouter.finish() parser flushed');
    } catch (err) {
      logger.error('OutputRouter.finish() parser.flush() failed: %s', err);
    }
    try {
      if (this.streamer) {
        logger.debug('OutputRouter.finish() calling streamer.finish()');
        await this.streamer.finish(exitCode);
        logger.debug('OutputRouter.finish() streamer finished');
      }
    } catch (err) {
      logger.error('OutputRouter.finish() streamer.finish() failed: %s', err);
    }
    try {
      logger.debug('OutputRouter.finish() calling logWriter.close()');
      this.logWriter.close(exitCode);
      logger.debug('OutputRouter.finish() logWriter closed');
    } catch (err) {
      logger.error('OutputRouter.finish() logWriter.close() failed: %s', err);
    }
  }

  /** Posts an extracted envelope message to Slack with its type prefix */
  private async onEnvelope(msg: EnvelopeMessage): Promise<void> {
    const prefix = msg.type ? (ENVELOPE_PREFIX[msg.type] ?? '') : '';
    const incTag = msg.incomplete ? ' ⚠️ *(incomplete)*' : '';
    const formattedText = markdownToSlack(msg.text);

    try {
      await this.opts.reporter.postMessage(
        this.opts.channelId,
        `${prefix}${formattedText}${incTag}`,
        this.opts.threadTs,
      );
    } catch (err) {
      logger.error('Failed to post envelope to Slack', err);
    }
  }
}
