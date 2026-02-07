import { WebClient } from '@slack/web-api';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Reporter');

/** Shape expected from files.getUploadURLExternal */
interface UploadURLResponse {
  url: string;
  file_id: string;
}

/**
 * Thin wrapper around Slack's Web API for posting, updating,
 * and uploading messages in channels.  Rate-limit retries stay
 * inside the SDK — callers do not need to handle 429s.
 */
export class SlackReporter {
  private readonly client: WebClient;

  constructor(botToken: string) {
    this.client = new WebClient(botToken);
  }

  /**
   * Posts a message.  If threadTs is provided the message is a reply
   * in that thread; otherwise it becomes the root of a new thread.
   * @returns The `ts` of the posted message (usable as thread_ts)
   */
  async postMessage(channelId: string, text: string, threadTs?: string): Promise<string> {
    const res = await this.client.chat.postMessage({
      channel:   channelId,
      text,
      thread_ts: threadTs,
    });
    return res.ts!;
  }

  /**
   * Posts a message with an interactive button using Block Kit.
   * @returns The `ts` of the posted message (usable for updates)
   */
  async postMessageWithButton(
    channelId: string,
    text: string,
    buttonText: string,
    buttonActionId: string,
    buttonValue: string,
    threadTs?: string
  ): Promise<string> {
    const res = await this.client.chat.postMessage({
      channel:   channelId,
      text,      // Fallback text for notifications
      thread_ts: threadTs,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text }
        },
        {
          type: 'actions',
          elements: [{
            type: 'button',
            text: { type: 'plain_text', text: buttonText },
            action_id: buttonActionId,
            value: buttonValue,
            style: 'danger'
          }]
        }
      ]
    });
    return res.ts!;
  }

  /** Edits an existing message in place (same channel + ts) */
  async updateMessage(channelId: string, ts: string, text: string): Promise<void> {
    await this.client.chat.update({ channel: channelId, ts, text });
  }

  /** Updates a message with Block Kit blocks (preserves interactive elements like buttons) */
  async updateMessageWithButton(
    channelId: string,
    ts: string,
    text: string,
    buttonText: string,
    buttonActionId: string,
    buttonValue: string
  ): Promise<void> {
    await this.client.chat.update({
      channel: channelId,
      ts,
      text,  // Fallback text
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text }
        },
        {
          type: 'actions',
          elements: [{
            type: 'button',
            text: { type: 'plain_text', text: buttonText },
            action_id: buttonActionId,
            value: buttonValue,
            style: 'danger'
          }]
        }
      ]
    });
  }

  /**
   * Uploads a text file to a channel using the modern three-step flow:
   *   1. getUploadURLExternal  → presigned URL + file_id
   *   2. POST content          → to the presigned URL
   *   3. completeUploadToChannel → finalise and attach to channel/thread
   */
  async uploadFile(channelId: string, content: string, filename: string, threadTs?: string): Promise<void> {
    const bytes = Buffer.byteLength(content, 'utf-8');

    // These methods may not yet appear in the bundled @slack/web-api types;
    // access them via the generic files namespace.
    const filesApi = this.client.files as unknown as {
      getUploadURLExternal: (p: { filename: string; length: number }) => Promise<UploadURLResponse>;
      completeUploadToChannel: (p: {
        channel_id: string;
        files: { id: string; title: string }[];
        thread_ts?: string;
      }) => Promise<void>;
    };

    // 1) Get presigned upload URL
    const { url, file_id } = await filesApi.getUploadURLExternal({ filename, length: bytes });

    // 2) Upload the content
    await fetch(url, {
      method:  'POST',
      body:    content,
      headers: { 'Content-Type': 'text/plain' },
    });

    // 3) Complete and attach to channel
    await filesApi.completeUploadToChannel({
      channel_id: channelId,
      files:      [{ id: file_id, title: filename }],
      thread_ts:  threadTs,
    });

    logger.info('Uploaded %s (%d bytes) → %s', filename, bytes, channelId);
  }
}
