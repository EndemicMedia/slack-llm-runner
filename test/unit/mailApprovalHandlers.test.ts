/**
 * Unit tests for the mail_approve/mail_reject Slack action handlers
 * (src/slack/listener.ts).
 *
 *   npx tsx --test test/unit/mailApprovalHandlers.test.ts
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  handleMailApprove,
  handleMailReject,
  renderExecutionOutcome,
  type MailHandlerDeps,
  type SlackPostClient,
} from '../../src/slack/listener.js';
import { MailStore } from '../../src/mail/threadStore.js';
import type { MailEnvelope } from '../../src/mail/types.js';
import type { ExecutionResult } from '../../src/mail/executor.js';

let tmpDir: string;
let dbPath: string;
let store: MailStore;

const ENVELOPE: MailEnvelope = {
  id: '1',
  account: 'work',
  folder: 'INBOX',
  messageId: '<m1@example.com>',
  inReplyTo: null,
  subject: 'Hello',
  fromAddr: 'alice@example.com',
  toAddrs: ['me@example.com'],
  date: '2026-09-01T10:00:00Z',
  rawJson: '{}',
};

function makeAction(id: string): void {
  store.createProposedAction({
    actionId: id,
    idempotencyKey: `key-${id}`,
    kind: 'archive',
    sourceMessageId: ENVELOPE.messageId!,
    paramsJson: JSON.stringify({ kind: 'archive' }),
    slackChannelId: 'C1',
    slackThreadTs: '100.0',
    slackMessageTs: '100.0',
  });
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-handler-test-'));
  dbPath = path.join(tmpDir, 'mail.db');
  store = new MailStore(dbPath);
  store.upsertEnvelope(ENVELOPE);
});

after(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface PostedMessage {
  channel?: string;
  thread_ts?: string;
  text?: string;
}

function fakeClient(): { client: SlackPostClient; posted: PostedMessage[] } {
  const posted: PostedMessage[] = [];
  const client: SlackPostClient = {
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        posted.push(args as PostedMessage);
        return {};
      },
    },
  };
  return { client, posted };
}

describe('handleMailApprove', () => {
  it('marks the action approved before invoking the executor', async () => {
    const actionId = 'approve-order-1';
    makeAction(actionId);
    const { client, posted } = fakeClient();

    let statusAtInvocation: string | undefined;
    const deps: MailHandlerDeps = {
      mailStore: store,
      mailDbPath: dbPath,
      client,
      runExecutor: async (id) => {
        statusAtInvocation = store.getProposedAction(id)?.status;
        const result: ExecutionResult = {
          actionId: id,
          kind: 'archive',
          success: true,
          outcome: 'executed',
        };
        return { stdout: JSON.stringify(result) };
      },
    };

    await handleMailApprove(actionId, 'C1', 'U1', '100.0', deps);

    assert.strictEqual(statusAtInvocation, 'approved');
    assert.strictEqual(store.getProposedAction(actionId)?.decidedBy, 'U1');
    assert.strictEqual(posted.length, 1);
    assert.match(posted[0].text ?? '', /Approved by <@U1>/);
    assert.match(posted[0].text ?? '', /archived/);
    assert.strictEqual(posted[0].channel, 'C1');
    assert.strictEqual(posted[0].thread_ts, '100.0');
  });

  it('posts a failure reply for a failed executor outcome', async () => {
    const actionId = 'approve-order-2';
    makeAction(actionId);
    const { client, posted } = fakeClient();

    const deps: MailHandlerDeps = {
      mailStore: store,
      mailDbPath: dbPath,
      client,
      runExecutor: async (id) => {
        const result: ExecutionResult = {
          actionId: id,
          kind: 'archive',
          success: false,
          outcome: 'failed',
          reason: 'himalaya exploded',
        };
        return { stdout: JSON.stringify(result) };
      },
    };

    await handleMailApprove(actionId, 'C1', 'U1', '100.0', deps);

    assert.strictEqual(posted.length, 1);
    assert.match(posted[0].text ?? '', /Failed to execute: himalaya exploded/);
  });

  it('posts an informational reply for a skipped executor outcome', async () => {
    const actionId = 'approve-order-3';
    makeAction(actionId);
    const { client, posted } = fakeClient();

    const deps: MailHandlerDeps = {
      mailStore: store,
      mailDbPath: dbPath,
      client,
      runExecutor: async (id) => {
        const result: ExecutionResult = {
          actionId: id,
          kind: 'archive',
          success: false,
          outcome: 'skipped',
          reason: 'already claimed for execution by another invocation',
        };
        return { stdout: JSON.stringify(result) };
      },
    };

    await handleMailApprove(actionId, 'C1', 'U1', '100.0', deps);

    assert.strictEqual(posted.length, 1);
    assert.match(posted[0].text ?? '', /Not executed/);
    assert.match(posted[0].text ?? '', /already claimed/);
  });

  it('posts an error reply when the executor subprocess itself fails to run', async () => {
    const actionId = 'approve-order-4';
    makeAction(actionId);
    const { client, posted } = fakeClient();

    const deps: MailHandlerDeps = {
      mailStore: store,
      mailDbPath: dbPath,
      client,
      runExecutor: async () => {
        throw new Error('spawn ENOENT');
      },
    };

    await handleMailApprove(actionId, 'C1', 'U1', '100.0', deps);

    assert.strictEqual(store.getProposedAction(actionId)?.status, 'approved');
    assert.strictEqual(posted.length, 1);
    assert.match(posted[0].text ?? '', /Failed to run the mail executor: spawn ENOENT/);
  });
});

describe('handleMailReject', () => {
  it('marks the action rejected and never invokes the executor', async () => {
    const actionId = 'reject-order-1';
    makeAction(actionId);
    const { client, posted } = fakeClient();

    await handleMailReject(actionId, 'C1', 'U2', '100.0', { mailStore: store, client });

    const row = store.getProposedAction(actionId);
    assert.strictEqual(row?.status, 'rejected');
    assert.strictEqual(row?.decidedBy, 'U2');
    assert.strictEqual(posted.length, 1);
    assert.match(posted[0].text ?? '', /Rejected by <@U2>/);
  });
});

describe('renderExecutionOutcome', () => {
  it('describes each action kind on a successful execution', () => {
    const kinds: Array<[ExecutionResult['kind'], string]> = [
      ['archive', 'archived'],
      ['delete', 'deleted'],
      ['move', 'moved'],
      ['flag', 'flag updated'],
      ['reply', 'reply sent'],
    ];
    for (const [kind, expected] of kinds) {
      const result: ExecutionResult = { actionId: 'x', kind, success: true, outcome: 'executed' };
      assert.match(renderExecutionOutcome(result, 'U1'), new RegExp(expected));
    }
  });
});
