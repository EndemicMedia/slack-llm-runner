import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { type AppConfig, type SessionSpawnOptions } from '../types.js';
import { type SlackReporter } from '../slack/reporter.js';
import { createLogger } from '../utils/logger.js';
import { OutputRouter } from '../streaming/router.js';
import { type Session, generateSessionId, stringToUuid } from './session.js';
import { spawnProcess, type ProcessHandle } from './processHandle.js';

const logger = createLogger('Runner');

/**
 * Owns the lifecycle of every active CLI session.
 * Spawns PTY processes, routes stdin from Slack thread replies,
 * and cleans up on exit or timeout.
 */
/** Persists after one-shot processes exit to enable session continuation */
interface ThreadBinding {
  prefix: string;
  sessionId: string;
  channelId: string;
}

export class SessionManager {
  /** Active sessions keyed by thread timestamp */
  private readonly sessions = new Map<string, Session>();
  /** Thread bindings keyed by `channelId:threadTs` — survive process exit */
  private readonly threadBindings = new Map<string, ThreadBinding>();

  constructor(
    private readonly config:   AppConfig,
    private readonly reporter: SlackReporter,
  ) {}

  /** True if an active session exists for the given thread timestamp */
  hasSession(threadTs: string): boolean {
    return this.sessions.has(threadTs);
  }

  /** Returns the thread binding for a channel+thread, or undefined */
  getThreadBinding(channelId: string, threadTs: string): ThreadBinding | undefined {
    return this.threadBindings.get(`${channelId}:${threadTs}`);
  }

  /** Removes a thread binding (called by Close button). Returns true if found. */
  removeThreadBinding(channelId: string, threadTs: string): boolean {
    return this.threadBindings.delete(`${channelId}:${threadTs}`);
  }

  /** Returns number of active thread bindings (for debugging) */
  getBindingCount(): number {
    return this.threadBindings.size;
  }

  /**
   * Spawns a new PTY session, wires up output routing, and posts a
   * start notification into the thread.
   */
  async spawn(options: SessionSpawnOptions): Promise<void> {
    const sessionId = generateSessionId();
    const { channelId, threadTs, command, config: cmdConfig, cwd } = options;

    logger.info('Spawn %s | prefix=%s mode=%s envelope=%s',
      sessionId, cmdConfig.prefix, cmdConfig.mode, cmdConfig.envelope);

    // Build output router (log + Slack tracks)
    const router = new OutputRouter({
      sessionId,
      channelId,
      threadTs,
      envelope:       cmdConfig.envelope,
      reporter:       this.reporter,
      envelopeConfig: {
        // One-shot mode: no PTY echo to skip, so activation delay must be 0
        activationDelayMs: cmdConfig.mode === 'one-shot' ? 0 : this.config.envelope.activationDelayMs,
        unclosedTimeoutMs: this.config.envelope.unclosedTimeoutMs,
      },
      streamConfig: {
        flushIntervalMs:    this.config.behavior.outputFlushIntervalMs,
        maxCharsPerMessage: this.config.behavior.outputMaxCharsPerMessage,
      },
    });

    // Determine spawn arguments
    // For one-shot envelope mode, prepend envelope instructions to the command
    let finalCommand = command;
    logger.debug('Envelope injection check: mode=%s envelope=%s promptTextLength=%d',
      cmdConfig.mode, cmdConfig.envelope, this.config.envelope.promptText?.length ?? 0);
    if (cmdConfig.mode === 'one-shot' && cmdConfig.envelope && this.config.envelope.promptText) {
      finalCommand = this.config.envelope.promptText + '\n\n' + command;
      logger.debug('Envelope injected, finalCommand length: %d', finalCommand.length);
    }

    let spawnArgs: string[];
    if (cmdConfig.mode === 'one-shot') {
      spawnArgs = [...(cmdConfig.args ?? [])];
      // Inject session flag if session continuation is active
      // Supports both sessionFlag (plain string) and sessionIdFlag (UUID format)
      const slackSessionId = `slack-${channelId}-${threadTs}`;
      const sessionId = options.sessionId ?? 
        (cmdConfig.sessionIdFlag ? stringToUuid(slackSessionId) : slackSessionId);
      logger.info('🔍 Session continuation debug: isContinuation=%s sessionId=%s slackSessionId=%s',
        options.isContinuation, sessionId, slackSessionId);
      
      if (cmdConfig.sessionFlag) {
        // Kimi-style: same flag for create and resume
        spawnArgs.push(cmdConfig.sessionFlag, sessionId);
        logger.info('✅ Injected session flag: %s %s', cmdConfig.sessionFlag, sessionId);
      } else if (cmdConfig.sessionIdFlag) {
        // Claude-style: --session-id for first call, --resume for continuation
        if (options.isContinuation && cmdConfig.resumeFlag) {
          spawnArgs.push(cmdConfig.resumeFlag, sessionId);
          logger.info('✅ Injected resume flag: %s %s', cmdConfig.resumeFlag, sessionId);
        } else {
          spawnArgs.push(cmdConfig.sessionIdFlag, sessionId);
          logger.info('✅ Injected session-id flag: %s %s', cmdConfig.sessionIdFlag, sessionId);
        }
      }
      // Inject prompt flag + command, or just append command
      if (cmdConfig.promptFlag) {
        spawnArgs.push(cmdConfig.promptFlag, finalCommand);
      } else {
        spawnArgs.push(finalCommand);  // e.g. bash -c <command>
      }
    } else {
      spawnArgs = [...(cmdConfig.args ?? [])];  // interactive: args only; input via stdin
      // For interactive mode with sessionIdFlag, inject UUID-based session ID
      if (cmdConfig.sessionIdFlag) {
        const slackSessionId = `slack-${channelId}-${threadTs}`;
        const uuidSessionId = stringToUuid(slackSessionId);
        logger.info('🔍 Claude session: slackId=%s uuid=%s', slackSessionId, uuidSessionId);
        spawnArgs.push(cmdConfig.sessionIdFlag, uuidSessionId);
        logger.info('✅ Injected session-id flag: %s %s', cmdConfig.sessionIdFlag, uuidSessionId);
      }
    }
    logger.debug('spawnArgs: %j', spawnArgs);
    logger.info('📝 Full spawn command: %s %s', cmdConfig.binary, spawnArgs.join(' '));

    // Spawn: child_process for one-shot (reliable), node-pty for interactive (needs TTY)
    let handle: ProcessHandle;
    try {
      handle = await spawnProcess(cmdConfig.binary, spawnArgs, {
        mode: cmdConfig.mode,
        cwd:  cwd ?? process.cwd(),
      });
    } catch (err) {
      logger.error('Spawn failed for %s: %s', cmdConfig.binary, err);
      await this.reporter.postMessage(channelId,
        `❌ Failed to start \`${cmdConfig.binary}\`: ${err}`, threadTs);
      return;
    }

    // CRITICAL: Attach event listeners IMMEDIATELY after spawn to avoid race condition
    // For fast commands, output can be emitted before async operations complete
    logger.debug('Attaching onData listener for %s', sessionId);
    handle.onData((data: string) => {
      logger.debug('onData callback fired: %d bytes', data.length);
      router.push(data);
    });

    // Wire process exit → cleanup (guard against double-fire)
    let exited = false;
    logger.debug('Attaching onExit listener for %s', sessionId);
    handle.onExit((exitCode: number) => {
      logger.debug('onExit callback fired with code %d for session %s', exitCode, sessionId);
      if (exited) {
        logger.debug('onExit already fired, ignoring duplicate');
        return;
      }
      exited = true;
      this.finalise(threadTs, exitCode).catch((err) => {
        logger.error('finalise() failed for session %s: %s', sessionId, err);
      });
    });

    // Spawn succeeded — start the output router (opens log, posts "Running…" if full mode)
    await router.start();

    // Post start notification (skip for continuations — less noise)
    let messageTs: string | undefined;
    if (!options.isContinuation) {
      // One-shot: no Close button needed (process finishes immediately)
      // Interactive: show Close button so user can stop long-running sessions
      if (cmdConfig.mode === 'one-shot') {
        messageTs = await this.reporter.postMessage(
          channelId,
          `🚀 Session started — ${cmdConfig.description}`,
          threadTs
        );
      } else {
        messageTs = await this.reporter.postMessageWithButton(
          channelId,
          `🚀 Session started — ${cmdConfig.description} (log: \`${sessionId}\`)`,
          'Close Session',
          'close_session',
          threadTs,
          threadTs
        );
      }
    }

    // Session timeout (only if not disabled)
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (cmdConfig.timeout !== false) {
      const timeoutMs = this.config.behavior.sessionTimeoutMinutes * 60_000;
      timeoutHandle = setTimeout(() => {
        logger.warn('Session %s timed out after %d min', sessionId, this.config.behavior.sessionTimeoutMinutes);
        handle.kill();
        void this.finalise(threadTs, -1);
      }, timeoutMs);
    }

    const session: Session = {
      id: sessionId, channelId, threadTs, messageTs, command,
      config: cmdConfig, status: 'running',
      startedAt: Date.now(), process: handle, router, timeoutHandle,
    };
    this.sessions.set(threadTs, session);

    // Register thread binding for commands with sessionFlag or sessionIdFlag (enables follow-up routing)
    if ((cmdConfig.sessionFlag || cmdConfig.sessionIdFlag) && !options.isContinuation) {
      const slackSessionId = `slack-${channelId}-${threadTs}`;
      // Use UUID format for sessionIdFlag (Claude), plain string for sessionFlag (Kimi)
      const bindingSessionId = options.sessionId ?? 
        (cmdConfig.sessionIdFlag ? stringToUuid(slackSessionId) : slackSessionId);
      const bindingKey = `${channelId}:${threadTs}`;
      this.threadBindings.set(bindingKey, {
        prefix: cmdConfig.prefix,
        sessionId: bindingSessionId,
        channelId,
      });
      logger.debug('Thread binding created: %s → sessionId=%s', bindingKey, bindingSessionId);
    }

    // For interactive sessions: inject envelope prompt then user input
    // Note: Need a small delay for the TUI (especially Claude) to initialize
    if (cmdConfig.mode === 'interactive') {
      const initDelayMs = cmdConfig.sessionIdFlag ? 2000 : 500; // Claude needs more time
      setTimeout(() => {
        if (cmdConfig.envelope && this.config.envelope.promptText) {
          handle.write(this.config.envelope.promptText + '\n');
        }
        if (command) {
          logger.info('Sending command to interactive session: %s', command.slice(0, 60));
          handle.write(command + '\n');
        }
      }, initDelayMs);
    }

    // Audit log
    this.appendAudit(sessionId, options);
  }

  /**
   * Writes user text to a running session's PTY stdin.
   * Silently ignored if no matching session exists.
   */
  sendInput(threadTs: string, text: string): void {
    const session = this.sessions.get(threadTs);
    if (!session || session.status !== 'running') return;
    logger.debug('stdin → %s: %s', session.id, text.slice(0, 60));
    session.process.write(text + '\n');
  }

  /**
   * Kills a running session identified by thread ts or session id.
   * @returns true if a session was found and killed
   */
  stop(identifier: string): boolean {
    const entry = this.findSession(identifier);
    if (!entry) return false;
    entry[1].process.kill();
    return true;
  }

  /**
   * Returns a lightweight summary of every active session
   * (consumed by the /status command).
   */
  listSessions(): Array<{ id: string; threadTs: string; command: string; status: string; uptimeMs: number }> {
    return [...this.sessions.values()].map((s) => ({
      id: s.id, threadTs: s.threadTs, command: s.command,
      status: s.status, uptimeMs: Date.now() - s.startedAt,
    }));
  }

  /**
   * Returns the session ID of the most recently started session, or null.
   * Used by /logs (without an argument) to resolve the latest log file.
   */
  getLatestSessionId(): string | null {
    let latest: Session | undefined;
    for (const s of this.sessions.values()) {
      if (!latest || s.startedAt > latest.startedAt) latest = s;
    }
    return latest?.id ?? null;
  }

  /** Looks up a session by thread ts first, then by session id */
  private findSession(identifier: string): [string, Session] | undefined {
    const direct = this.sessions.get(identifier);
    if (direct) return [identifier, direct];
    for (const [ts, session] of this.sessions) {
      if (session.id === identifier) return [ts, session];
    }
    return undefined;
  }

  /** Finalises a session: posts completion banner, closes logs, removes from map */
  private async finalise(threadTs: string, exitCode: number): Promise<void> {
    logger.debug('finalise() called for threadTs=%s exitCode=%d', threadTs, exitCode);

    const session = this.sessions.get(threadTs);
    if (!session) {
      logger.warn('finalise() called but no session found for threadTs=%s', threadTs);
      return;
    }

    logger.debug('finalise() found session %s, clearing timeout', session.id);
    if (session.timeoutHandle) {
      clearTimeout(session.timeoutHandle);
    }
    session.status   = exitCode === -1 ? 'timed_out' : 'exited';
    session.exitCode = exitCode;

    logger.debug('finalise() calling router.finish() for session %s', session.id);
    await session.router.finish(exitCode);
    logger.debug('finalise() router.finish() completed');

    const label =
      exitCode === -1  ? '⏱️ Session timed out'
    : exitCode === 0   ? '✅ Session complete (exit code 0)'
    :                    `❌ Session ended (exit code ${exitCode})`;

    // If session has messageTs, update the start message to show completion
    if (session.messageTs) {
      logger.debug('finalise() updating session start message');
      try {
        if (session.config.mode === 'one-shot') {
          await this.reporter.updateMessage(
            session.channelId,
            session.messageTs,
            `🚀 Session started — ${session.config.description}\n${label}`,
          );
        } else {
          await this.reporter.updateMessageWithButton(
            session.channelId,
            session.messageTs,
            `🚀 Session started — ${session.config.description}\n${label}`,
            'Close Session',
            'close_session',
            threadTs
          );
        }
      } catch (err) {
        logger.error('Failed to update session start message', err);
      }
    }
    // For continuations (no messageTs), we stay silent — output already posted to thread

    logger.info('Session %s finished | exit=%d', session.id, exitCode);
    this.sessions.delete(threadTs);
    logger.debug('finalise() complete, session removed from map');
  }

  /** Appends a JSON line to the append-only audit log */
  private appendAudit(sessionId: string, opts: SessionSpawnOptions): void {
    const logDir = resolve(process.cwd(), 'logs');
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      sessionId,
      channelId: opts.channelId,
      command:   opts.command,
      prefix:    opts.config.prefix,
    }) + '\n';

    appendFileSync(resolve(logDir, 'audit.log'), entry);
  }
}
