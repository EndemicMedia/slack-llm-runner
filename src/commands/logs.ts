import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { resolve } from 'path';
import { type SlackReporter } from '../slack/reporter.js';
import { type SessionManager } from '../cli/runner.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('LogsCommand');

/** Maximum file size (bytes) that Slack accepts for upload */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Handles all /logs sub-commands:
 *   /logs           — upload most recent session log
 *   /logs <id>      — upload a specific session log
 *   /logs tail <N>  — post the last N lines inline
 *   /logs list      — list available session logs
 */
export class LogsCommand {
  private readonly sessionsDir = resolve(process.cwd(), 'logs', 'sessions');

  constructor(
    private readonly reporter: SlackReporter,
    private readonly runner:   SessionManager,
  ) {}

  /** Routes to the appropriate sub-handler based on the argument string */
  async handle(args: string, channelId: string, threadTs: string): Promise<void> {
    if (args === 'list')          return this.list(channelId, threadTs);
    if (args.startsWith('tail ')) {
      const n = parseInt(args.slice(5), 10);
      return this.tail(isNaN(n) ? 50 : n, channelId, threadTs);
    }
    if (args) return this.uploadById(args, channelId, threadTs);
    return this.uploadLatest(channelId, threadTs);
  }

  // ── sub-command implementations ──────────────────────────────────────────

  /** Lists the most recent session log files (newest last, up to 20) */
  private async list(channelId: string, threadTs: string): Promise<void> {
    const files = this.getLogFiles();
    if (!files.length) {
      await this.reporter.postMessage(channelId, 'No session logs found.', threadTs);
      return;
    }
    const lines = files.slice(-20).map((f) => {
      const size = statSync(resolve(this.sessionsDir, f)).size;
      return `• \`${f.replace('.log', '')}\` — ${(size / 1024).toFixed(1)} KB`;
    });
    await this.reporter.postMessage(channelId, `*Recent logs:*\n${lines.join('\n')}`, threadTs);
  }

  /** Posts the last N lines of the latest log as a code block */
  private async tail(n: number, channelId: string, threadTs: string): Promise<void> {
    const path = this.resolveLog(null);
    if (!path) {
      await this.reporter.postMessage(channelId, 'No session logs found.', threadTs);
      return;
    }
    const lines = readFileSync(path, 'utf-8').split('\n').slice(-n);
    await this.reporter.postMessage(channelId, `\`\`\`\n${lines.join('\n')}\n\`\`\``, threadTs);
  }

  /** Uploads a log identified by session ID */
  private async uploadById(sessionId: string, channelId: string, threadTs: string): Promise<void> {
    const path = this.resolveLog(sessionId);
    if (!path) {
      await this.reporter.postMessage(channelId, `Log not found: \`${sessionId}\``, threadTs);
      return;
    }
    await this.doUpload(path, sessionId, channelId, threadTs);
  }

  /** Uploads the most recent session log */
  private async uploadLatest(channelId: string, threadTs: string): Promise<void> {
    // Prefer the runner's in-memory latest; fall back to most-recent file on disk
    const latestId = this.runner.getLatestSessionId();
    const path     = latestId
      ? (this.resolveLog(latestId) ?? this.resolveLog(null))
      : this.resolveLog(null);

    if (!path) {
      await this.reporter.postMessage(channelId, 'No session logs found.', threadTs);
      return;
    }
    const name = path.split(/[\\/]/).pop()!.replace('.log', '');
    await this.doUpload(path, name, channelId, threadTs);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Uploads a log file; truncates (keeping the tail) if it exceeds the limit */
  private async doUpload(
    path: string, label: string, channelId: string, threadTs: string,
  ): Promise<void> {
    let content = readFileSync(path, 'utf-8');
    let notice  = '';

    if (Buffer.byteLength(content) > MAX_UPLOAD_BYTES) {
      // Iteratively drop the first half until it fits
      while (Buffer.byteLength(content) > MAX_UPLOAD_BYTES) {
        content = content.slice(Math.floor(content.length / 2));
      }
      notice = '\n⚠️ Log was truncated (first portion omitted — exceeded 20 MB).';
    }

    await this.reporter.uploadFile(channelId, content, `${label}.log`, threadTs);
    if (notice) await this.reporter.postMessage(channelId, notice, threadTs);
    logger.info('Uploaded log %s (%d chars)', label, content.length);
  }

  /**
   * Resolves a log file path.
   * @param sessionId Specific session ID, or null for the most recent file on disk
   */
  private resolveLog(sessionId: string | null): string | undefined {
    if (!existsSync(this.sessionsDir)) return undefined;

    if (sessionId) {
      const candidate = resolve(this.sessionsDir, `${sessionId}.log`);
      return existsSync(candidate) ? candidate : undefined;
    }

    // Most recent by modification time
    const files = this.getLogFiles();
    return files.length ? resolve(this.sessionsDir, files[files.length - 1]) : undefined;
  }

  /** Returns .log file names sorted by mtime ascending (oldest first) */
  private getLogFiles(): string[] {
    if (!existsSync(this.sessionsDir)) return [];
    return readdirSync(this.sessionsDir)
      .filter((f) => f.endsWith('.log'))
      .sort((a, b) =>
        statSync(resolve(this.sessionsDir, a)).mtimeMs -
        statSync(resolve(this.sessionsDir, b)).mtimeMs,
      );
  }
}
