import { type SlackReporter } from '../slack/reporter.js';
import { createLogger } from '../utils/logger.js';
import { stripAnsi } from './ansiStrip.js';

const logger = createLogger('FullStreamer');

export interface FullStreamerOptions {
  reporter: SlackReporter;
  channelId: string;
  threadTs: string;
  /** ms between chat.update calls */
  flushIntervalMs: number;
  /** char limit before splitting into a new Slack message */
  maxCharsPerMessage: number;
}

/**
 * Streams all CLI output to Slack via a buffered chat.update loop.
 * Posts an initial placeholder message, then periodically updates it
 * with new output.  Splits into new messages when the accumulated
 * buffer exceeds the configured character limit.
 */
export class FullStreamer {
  private buffer = '';
  private currentTs: string | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly opts: FullStreamerOptions) {}

  /** Posts the initial "Running…" message and begins the flush loop */
  async start(): Promise<void> {
    this.currentTs = await this.opts.reporter.postMessage(
      this.opts.channelId,
      '⏳ Running…',
      this.opts.threadTs,
    );
    this.flushTimer = setInterval(() => void this.flush(), this.opts.flushIntervalMs);
  }

  /** Buffers a raw PTY chunk (ANSI-stripped) for the next flush cycle */
  push(data: string): void {
    if (this.stopped) return;
    const stripped = stripAnsi(data);
    logger.debug('FullStreamer.push: %d bytes', stripped.length);
    this.buffer += stripped;
  }

  /**
   * Performs one final flush and appends an exit-status indicator.
   * @param exitCode Process exit code
   */
  async finish(exitCode: number): Promise<void> {
    this.stopped = true;
    if (this.flushTimer) clearInterval(this.flushTimer);

    const status  = exitCode === 0 ? '✅' : '❌';
    const code    = this.buffer.trim()
      ? `\`\`\`\n${this.buffer.trim()}\n\`\`\`\n`
      : '';

    if (this.currentTs) {
      await this.opts.reporter.updateMessage(
        this.opts.channelId,
        this.currentTs,
        `${code}${status} Exited with code ${exitCode}`,
      );
    }
    this.buffer = '';
  }

  /** Pushes buffered content to Slack; splits the message if over the limit */
  private async flush(): Promise<void> {
    if (!this.buffer || !this.currentTs || this.stopped) return;

    try {
      if (this.buffer.length > this.opts.maxCharsPerMessage) {
        // Finalise current message with the chunk, then open a new one
        const chunk = this.buffer.slice(0, this.opts.maxCharsPerMessage);
        this.buffer = this.buffer.slice(this.opts.maxCharsPerMessage);

        await this.opts.reporter.updateMessage(
          this.opts.channelId, this.currentTs,
          `\`\`\`\n${chunk}\n\`\`\``,
        );
        this.currentTs = await this.opts.reporter.postMessage(
          this.opts.channelId, '⏳ …', this.opts.threadTs,
        );
      } else {
        await this.opts.reporter.updateMessage(
          this.opts.channelId, this.currentTs,
          `\`\`\`\n${this.buffer}\n\`\`\``,
        );
      }
    } catch (err) {
      logger.error('Flush failed; will retry next cycle', err);
    }
  }
}
