import { resolve } from 'path';
import { mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { loadConfig } from './utils/config.js';
import { createLogger, setLogLevel } from './utils/logger.js';
import { createApp } from './slack/app.js';
import { SlackReporter } from './slack/reporter.js';
import { registerListeners } from './slack/listener.js';
import { CommandRouter } from './commands/router.js';
import { SessionManager } from './cli/runner.js';
import { Authorizer } from './security/authorizer.js';
import { Scheduler } from './scheduler/scheduler.js';

// Enable debug logging from the start
setLogLevel('debug');

const logger = createLogger('Main');

// ── startup helpers ──────────────────────────────────────────────────────────

/** Ensures logs/ and logs/sessions/ directories exist */
function ensureDirs(): void {
  for (const sub of ['logs', resolve('logs', 'sessions')]) {
    const p = resolve(process.cwd(), sub);
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }
}

/** Removes session logs older than retentionDays */
function cleanupOldLogs(retentionDays: number): void {
  const dir = resolve(process.cwd(), 'logs', 'sessions');
  if (!existsSync(dir)) return;

  const cutoff = Date.now() - retentionDays * 86_400_000;
  for (const file of readdirSync(dir)) {
    const path = resolve(dir, file);
    if (statSync(path).mtimeMs < cutoff) {
      unlinkSync(path);
      logger.debug('Cleaned up old log: %s', file);
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();
  logger.debug('🔧 DEBUG LOGGING IS ACTIVE - this message proves it!');
  logger.info('Configuration loaded | channels=%d commands=%d jobs=%d',
    config.slack.listenChannels.length, config.commands.length, config.jobs.length);

  ensureDirs();
  cleanupOldLogs(config.logging.sessionRetentionDays);

  // ── wire up components ─────────────────────────────────────────────────
  const app       = createApp(config.slack.botToken, config.slack.appToken);
  const reporter  = new SlackReporter(config.slack.botToken);
  const runner    = new SessionManager(config, reporter);
  const authorizer = new Authorizer(config);
  const router    = new CommandRouter(config, reporter, runner, authorizer);
  const scheduler = new Scheduler(config, reporter, runner);

  registerListeners(app, router, config.slack.listenChannels);
  scheduler.start();

  // Handle Socket Mode client errors gracefully
  const client = (app as any).client;
  if (client) {
    client.on('error', (err: any) => {
      logger.error('Socket Mode client error: %s', err?.message || err);
      if (err?.message?.includes('server explicit disconnect')) {
        logger.warn('Server disconnected - check for multiple bot instances');
      }
    });
  }

  // Handle uncaught exceptions from Socket Mode
  process.on('uncaughtException', (err: Error) => {
    if (err.message?.includes('server explicit disconnect')) {
      logger.warn('Socket Mode disconnect - another instance may be connected. Exiting cleanly.');
      scheduler.stop();
      process.exit(1);
    }
    console.error('[FATAL UNCAUGHT]', err);
    process.exit(1);
  });

  // ── start the Bolt app (Socket Mode WebSocket) ────────────────────────
  try {
    await app.start();
    logger.info('Bolt app connected via Socket Mode');
  } catch (err) {
    logger.error('Failed to start Bolt app: %s', err);
    throw err;
  }

  // Post a "restarted" notice to every configured listen channel
  for (const ch of config.slack.listenChannels) {
    await reporter.postMessage(ch, '🔄 Slack CLI Wrapper restarted and listening.')
      .catch(() => { /* ignore if bot lacks access */ });
  }

  // ── graceful shutdown ──────────────────────────────────────────────────
  const shutdown = (): void => {
    scheduler.stop();
    logger.info('Shutting down');
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
