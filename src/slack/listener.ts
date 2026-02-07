import { type CommandRouter } from '../commands/router.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Listener');

/**
 * Registers the Bolt message-event listener that feeds incoming
 * Slack messages into the command router.  Filters out bot messages
 * (subtypes) and messages outside the configured channel list.
 */
export function registerListeners(
  app:            any,
  router:         CommandRouter,
  listenChannels: string[],
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
}
