import { type CommandRouter } from '../commands/router.js';
import { createLogger } from '../utils/logger.js';
import type { MailStore } from '../mail/threadStore.js';
import type { ExecutionResult } from '../mail/executor.js';

const logger = createLogger('Listener');

/** Minimal Slack `client` surface the mail handlers need — lets tests inject a fake. */
export interface SlackPostClient {
  chat: {
    postMessage: (args: Record<string, unknown>) => Promise<unknown>;
  };
}

/** Result of running the mail executor as a subprocess, decoupled from `child_process` for testing. */
export interface ExecutorRunResult {
  stdout: string;
}

/** Injectable dependencies for the mail approve/reject handlers. */
export interface MailHandlerDeps {
  mailStore: MailStore;
  mailDbPath: string;
  client: SlackPostClient;
  /** Runs the mail executor subprocess; returns its stdout. Defaults to a real `execFile` call. */
  runExecutor: (actionId: string, dbPath: string) => Promise<ExecutorRunResult>;
}

/**
 * Handles a `mail_approve` button click: records the approval BEFORE invoking
 * the executor (load-bearing — see executor.ts), runs the executor as a
 * separate process, and posts a threaded reply with the outcome.
 */
export async function handleMailApprove(
  actionId:  string,
  channelId: string | undefined,
  userId:    string | undefined,
  threadTs:  string | undefined,
  deps:      MailHandlerDeps,
): Promise<void> {
  if (!userId) {
    logger.warn('mail_approve click missing user id');
    return;
  }

  deps.mailStore.markDecided(actionId, 'approved', userId);
  logger.info('Mail action %s approved by %s', actionId, userId);

  let result: ExecutionResult;
  try {
    const { stdout } = await deps.runExecutor(actionId, deps.mailDbPath);
    result = JSON.parse(stdout) as ExecutionResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Failed to run mail executor for action %s: %s', actionId, message);
    await postThreadReply(deps.client, channelId, threadTs, `❌ Failed to run the mail executor: ${message}`);
    return;
  }

  const text = renderExecutionOutcome(result, userId);
  await postThreadReply(deps.client, channelId, threadTs, text);
}

/**
 * Handles a `mail_reject` button click: records the rejection and posts a
 * threaded reply. Never invokes the executor — rejection never touches
 * himalaya.
 */
export async function handleMailReject(
  actionId:  string,
  channelId: string | undefined,
  userId:    string | undefined,
  threadTs:  string | undefined,
  deps:      Pick<MailHandlerDeps, 'mailStore' | 'client'>,
): Promise<void> {
  if (!userId) {
    logger.warn('mail_reject click missing user id');
    return;
  }

  deps.mailStore.markDecided(actionId, 'rejected', userId);
  logger.info('Mail action %s rejected by %s', actionId, userId);

  await postThreadReply(deps.client, channelId, threadTs, `❌ Rejected by <@${userId}>`);
}

/** Renders the confirmation text for an executor outcome. Exported for tests. */
export function renderExecutionOutcome(result: ExecutionResult, userId: string): string {
  switch (result.outcome) {
    case 'executed':
      return `✅ Approved by <@${userId}> — ${describeExecuted(result)}`;
    case 'failed':
      return `❌ Failed to execute: ${result.reason ?? 'unknown error'}`;
    case 'skipped':
      return `ℹ️ Not executed: ${result.reason ?? 'action was already handled'}`;
  }
}

function describeExecuted(result: ExecutionResult): string {
  switch (result.kind) {
    case 'archive': return 'archived';
    case 'delete':  return 'deleted';
    case 'move':    return 'moved';
    case 'flag':    return 'flag updated';
    case 'reply':   return 'reply sent';
    default:        return 'done';
  }
}

async function postThreadReply(
  client:    SlackPostClient,
  channelId: string | undefined,
  threadTs:  string | undefined,
  text:      string,
): Promise<void> {
  if (!channelId) {
    logger.warn('No channel id available to post reply: %s', text);
    return;
  }
  try {
    await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
  } catch (err) {
    logger.error('Failed to post threaded reply', err);
  }
}

/**
 * Registers the Bolt message-event listener that feeds incoming
 * Slack messages into the command router.  Filters out bot messages
 * (subtypes) and messages outside the configured channel list.
 *
 * `mailStore`/`mailDbPath` are optional: the `mail_approve`/`mail_reject`
 * action handlers are only registered when both are supplied, so callers
 * that haven't wired the mail feature yet get identical behavior to before.
 */
export function registerListeners(
  app:            any,
  router:         CommandRouter,
  listenChannels: string[],
  mailStore?:     MailStore,
  mailDbPath?:    string,
): void {
  app.message(async ({ message }: { message: any }) => {
    console.log('[LISTENER] ========== MESSAGE RECEIVED ==========');
    console.log('[LISTENER] Text:', message?.text);
    // Log raw Slack message
    logger.debug('RAW SLACK MESSAGE: %O', {
      keys: Object.keys(message),
      type: typeof message,
      channel: message.channel,
      user: message.user,
      text: message.text,
      ts: message.ts,
      thread_ts: message.thread_ts,
      subtype: message.subtype,
    });

    // Ignore subtypes: bot_message, channel_join, channel_leave, etc.
    if ('subtype' in message && message.subtype) {
      logger.debug('Ignoring message with subtype: %s', message.subtype);
      return;
    }

    const channelId = 'channel'   in message ? (message.channel   as string | undefined) : undefined;
    if (!channelId || !listenChannels.includes(channelId)) {
      logger.debug('Channel not in listen list: %s', channelId);
      return;
    }

    const userId   = 'user'      in message ? (message.user      as string | undefined) : undefined;
    if (!userId) {
      logger.debug('No user ID in message');
      return;
    }

    const text      = ('text' in message ? (message.text as string) : '') || '';
    const threadTs  = 'thread_ts' in message ? (message.thread_ts as string | undefined) : undefined;
    const ts        = message.ts as string;

    logger.debug('EXTRACTED: channel=%s user=%s thread=%s ts=%s text="%s"',
      channelId, userId, threadTs ?? 'null', ts, text);

    logger.debug('CALLING router.handleMessage with: %O',
      { channelId, userId, text, threadTs, ts });

    await router.handleMessage({ channelId, userId, text, threadTs, ts });
  });

  // Handle "Close Session" button clicks
  app.action('close_session', async ({ body, ack, client }: { body: any; ack: any; client: any }) => {
    await ack();

    const threadTs = body.actions[0].value;
    const channelId = body.channel?.id;
    logger.info('Close session button clicked for thread %s', threadTs);

    // Stop active process (if any) and remove thread binding
    const stopped = router.runner.stop(threadTs);
    const unbound = channelId ? router.runner.removeThreadBinding(channelId, threadTs) : false;
    logger.debug('Session stop=%s, binding removed=%s', stopped, unbound);

    if (stopped || unbound) {
      // Update message to show session was closed
      try {
        await client.chat.update({
          channel: channelId,
          ts: body.message?.ts,
          text: '🚀 Session started (closed by user)',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `🚀 Session closed by user at ${new Date().toLocaleTimeString()}`
              }
            }
          ]
        });
        logger.info('Session closed and message updated');
      } catch (err) {
        logger.error('Failed to update message after closing session', err);
      }
    } else {
      logger.warn('No active session or binding for thread %s', threadTs);
    }
  });

  if (mailStore && mailDbPath) {
    // Handle "Approve" button clicks on mail digest items
    app.action('mail_approve', async ({ body, ack, client }: { body: any; ack: any; client: any }) => {
      await ack();

      const actionId  = body.actions[0].value as string;
      const channelId = body.channel?.id as string | undefined;
      const userId    = body.user?.id as string | undefined;
      const messageTs = body.message?.ts as string | undefined;
      logger.info('Mail approve button clicked for action %s', actionId);

      await handleMailApprove(actionId, channelId, userId, messageTs, {
        mailStore,
        mailDbPath,
        client,
        runExecutor: runExecutorSubprocess,
      });
    });

    // Handle "Reject" button clicks on mail digest items
    app.action('mail_reject', async ({ body, ack, client }: { body: any; ack: any; client: any }) => {
      await ack();

      const actionId  = body.actions[0].value as string;
      const channelId = body.channel?.id as string | undefined;
      const userId    = body.user?.id as string | undefined;
      const messageTs = body.message?.ts as string | undefined;
      logger.info('Mail reject button clicked for action %s', actionId);

      await handleMailReject(actionId, channelId, userId, messageTs, { mailStore, client });
    });
  } else {
    logger.debug('MailStore not provided — mail_approve/mail_reject handlers not registered');
  }
}

/** Real executor runner: invokes `dist/mail/executor.js execute <actionId>` as a subprocess. */
async function runExecutorSubprocess(actionId: string, dbPath: string): Promise<ExecutorRunResult> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const path = await import('node:path');
  const run = promisify(execFile);

  const { stdout } = await run('node', [path.join(process.cwd(), 'dist/mail/executor.js'), 'execute', actionId], {
    env: { ...process.env, MAILCTL_DB_PATH: dbPath },
  });
  return { stdout };
}
