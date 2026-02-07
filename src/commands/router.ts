import { type AppConfig, type ParsedCommand } from '../types.js';
import { type SlackReporter } from '../slack/reporter.js';
import { type SessionManager } from '../cli/runner.js';
import { type Authorizer } from '../security/authorizer.js';
import { checkCommand } from '../security/commandFilter.js';
import { parseCommand } from './parser.js';
import { LogsCommand } from './logs.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('CommandRouter');

/** Shape of a message arriving from the Slack listener */
export interface IncomingMessage {
  channelId: string;
  userId:   string;
  text:      string;
  threadTs:  string | undefined;
  ts:        string;
}

/**
 * Central dispatcher implementing the full decision tree:
 *   channel filter → user auth → active-session stdin → command parse → route
 */
export class CommandRouter {
  private readonly logsCmd: LogsCommand;

  constructor(
    private readonly config:     AppConfig,
    private readonly reporter:   SlackReporter,
    public readonly runner:      SessionManager,
    private readonly authorizer: Authorizer,
  ) {
    this.logsCmd = new LogsCommand(this.reporter, this.runner);
  }

  /**
   * Main entry-point — called once per incoming Slack message.
   */
  async handleMessage(msg: IncomingMessage): Promise<void> {
    const { channelId, userId, text, threadTs, ts } = msg;

    logger.debug('📨 handleMessage called: %O', { channelId, userId, text, threadTs, ts });

    // 1) Channel filter
    const channelAllowed = this.authorizer.isChannelAllowed(channelId);
    logger.debug('  1) Channel allowed: %s', channelAllowed);
    if (!channelAllowed) {
      logger.debug('  ❌ Channel not allowed, returning');
      return;
    }

    // 2) User authorization
    const userAllowed = this.authorizer.isUserAllowed(userId, channelId);
    logger.debug('  2) User allowed: %s', userAllowed);
    if (!userAllowed) {
      logger.debug('  ❌ User not allowed, posting error');
      await this.reporter.postMessage(channelId, 'You are not authorized to run commands here.', ts);
      return;
    }

    // 3) Thread binding exists → spawn continuation one-shot (e.g. Kimi/Claude follow-up)
    // This takes precedence over active session stdin for one-shot commands
    logger.debug('  3) Checking thread binding: threadTs=%s channelId=%s bindingCount=%d',
      threadTs, channelId, this.runner.getBindingCount());
    if (threadTs) {
      const binding = this.runner.getThreadBinding(channelId, threadTs);
      logger.info('🔍 Thread binding lookup: key=%s:%s result=%s',
        channelId, threadTs, binding ? `prefix=${binding.prefix} sessionId=${binding.sessionId}` : 'NOT FOUND');
      if (binding) {
        const cmdConfig = this.config.commands.find((c) => c.prefix === binding.prefix);
        if (cmdConfig) {
          logger.info('✅ Spawning continuation: prefix=%s sessionId=%s text="%s"',
            binding.prefix, binding.sessionId, text.slice(0, 60));
          await this.runner.spawn({
            channelId,
            threadTs,
            command: text,
            config: cmdConfig,
            sessionId: binding.sessionId,
            isContinuation: true,
          });
          return;
        }
      }
    } else {
      logger.debug('  3) No threadTs — skipping binding check');
    }

    // 3.5) Reply in an active interactive session thread → forward as stdin
    // (for truly interactive sessions like bash REPL, not one-shot commands)
    const hasSession = this.runner.hasSession(threadTs!);
    logger.debug('  3.5) Active session in thread: %s', hasSession);
    if (threadTs && hasSession) {
      logger.debug('  ℹ️ Forwarding as stdin to session');
      this.runner.sendInput(threadTs, text);
      return;
    }

    // 4) Parse the message into a command
    logger.debug('  4) Parsing command from text: "%s"', text);
    const parsed = parseCommand(text, this.config.commands);
    logger.debug('  4) Parsed result: %O', parsed);
    if (!parsed) {
      logger.debug('  ❌ Not a recognized command, ignoring');
      return;
    }

    // 5) Route
    logger.debug('  5) Routing command: %O', parsed);
    if (parsed.isControl) {
      logger.debug('  → Control command');
      await this.handleControl(parsed, channelId, ts);
    } else {
      logger.debug('  → CLI command (prefix: %s)', parsed.prefix);
      await this.handleCli(parsed, channelId, ts);
    }
  }

  /** Dispatches /status, /stop, /logs, /jobs, /help */
  private async handleControl(cmd: ParsedCommand, channelId: string, ts: string): Promise<void> {
    switch (cmd.prefix) {
      case '/status': await this.postStatus(channelId, ts);            break;
      case '/stop':   await this.postStop(cmd.args, channelId, ts);    break;
      case '/logs':   await this.logsCmd.handle(cmd.args, channelId, ts); break;
      case '/jobs':   await this.postJobs(channelId, ts);              break;
      case '/help':   await this.postHelp(channelId, ts);              break;
    }
  }

  /** Validates prefix + blocklist, then spawns a new CLI session */
  private async handleCli(cmd: ParsedCommand, channelId: string, ts: string): Promise<void> {
    if (!this.authorizer.isPrefixAllowed(cmd.prefix, channelId)) {
      await this.reporter.postMessage(channelId,
        `Command \`${cmd.prefix}\` is not allowed in this channel.`, ts);
      return;
    }

    const blocked = checkCommand(cmd.args);
    if (blocked) {
      await this.reporter.postMessage(channelId, `🚫 ${blocked}`, ts);
      return;
    }

    if (!cmd.args) {
      await this.reporter.postMessage(channelId,
        `Please provide a command after \`${cmd.prefix}:\`.`, ts);
      return;
    }

    const cmdConfig = this.config.commands.find((c) => c.prefix === cmd.prefix)!;
    await this.runner.spawn({
      channelId,
      threadTs: ts,       // new thread rooted at this message
      command:  cmd.args,
      config:   cmdConfig,
    });
  }

  // ── control-command handlers ─────────────────────────────────────────────

  /** /status — lists active sessions */
  private async postStatus(channelId: string, ts: string): Promise<void> {
    const sessions = this.runner.listSessions();
    if (!sessions.length) {
      await this.reporter.postMessage(channelId, 'No active sessions.', ts);
      return;
    }
    const lines = sessions.map((s) => {
      const up = Math.round(s.uptimeMs / 1000);
      return `• \`${s.id}\` — ${s.command.slice(0, 50)} (${s.status}, ${up}s)`;
    });
    await this.reporter.postMessage(channelId, `*Active sessions:*\n${lines.join('\n')}`, ts);
  }

  /** /stop — kills a session by id or thread ts */
  private async postStop(args: string, channelId: string, ts: string): Promise<void> {
    if (!args) {
      await this.reporter.postMessage(channelId,
        'Usage: `/stop <sessionId or thread_ts>`', ts);
      return;
    }
    if (!this.runner.stop(args)) {
      await this.reporter.postMessage(channelId,
        'Session not found. Use `/status` to list active sessions.', ts);
    }
  }

  /** /jobs — lists all configured scheduled jobs */
  private async postJobs(channelId: string, ts: string): Promise<void> {
    if (!this.config.jobs.length) {
      await this.reporter.postMessage(channelId, 'No scheduled jobs configured.', ts);
      return;
    }
    const lines = this.config.jobs.map((j) =>
      `• *${j.label ?? j.name}* — \`${j.cron}\` → ${j.command}`);
    await this.reporter.postMessage(channelId, `*Scheduled jobs:*\n${lines.join('\n')}`, ts);
  }

  /** /help — available commands and control reference */
  private async postHelp(channelId: string, ts: string): Promise<void> {
    const prefixes = this.config.commands.map((c) =>
      `\`${c.prefix}: <text>\` — ${c.description}`);

    const text = [
      '*Commands:*',
      ...prefixes,
      '',
      '*Control:*',
      '`/status` — active sessions',
      '`/stop <id>` — kill a session',
      '`/logs` — upload latest log',
      '`/logs <id>` — upload a specific log',
      '`/logs tail <N>` — last N lines inline',
      '`/logs list` — list recent logs',
      '`/jobs` — scheduled jobs',
      '`/help` — this message',
    ].join('\n');

    await this.reporter.postMessage(channelId, text, ts);
  }
}
