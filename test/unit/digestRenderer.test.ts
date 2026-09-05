/**
 * Unit tests for renderDigestBlocks (src/mail/digestRenderer.ts) — backed by
 * a real temp MailStore rather than a mock, so we catch real reconciliation
 * behavior against SQLite.
 *
 *   npx tsx --test test/unit/digestRenderer.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { MailStore, type NewProposedAction } from '../../src/mail/threadStore.js';
import type { MailDigest } from '../../src/mail/types.js';
import { renderDigestBlocks } from '../../src/mail/digestRenderer.js';

let dbPath: string;
let store: MailStore;

before(() => {
  dbPath = path.join(os.tmpdir(), `digestrenderer-test-${crypto.randomUUID()}.db`);
  store = new MailStore(dbPath);
});

after(() => {
  store.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});

function baseAction(overrides: Partial<NewProposedAction>): NewProposedAction {
  return {
    actionId: 'act-pending',
    idempotencyKey: crypto.randomUUID(),
    kind: 'archive',
    sourceMessageId: '<msg-1@example.com>',
    paramsJson: JSON.stringify({ kind: 'archive' }),
    slackChannelId: 'C123',
    slackThreadTs: '111.222',
    slackMessageTs: null,
    ...overrides,
  };
}

describe('renderDigestBlocks', () => {
  it('renders Approve/Reject buttons for an item whose action is pending', () => {
    store.createProposedAction(baseAction({ actionId: 'act-pending', idempotencyKey: 'idem-pending' }));

    const digest: MailDigest = {
      summary: 'You have 1 item to review.',
      items: [
        {
          sourceMessageId: '<msg-1@example.com>',
          subject: 'Pending subject',
          from: 'sender@example.com',
          analysis: 'Looks safe to archive.',
          proposedActionId: 'act-pending',
        },
      ],
    };

    const blocks = renderDigestBlocks(digest, store);

    const actionsBlock = blocks.find((b) => b.type === 'actions') as any;
    assert.ok(actionsBlock, 'expected an actions block for a pending item');
    assert.strictEqual(actionsBlock.elements.length, 2);
    assert.strictEqual(actionsBlock.elements[0].action_id, 'mail_approve');
    assert.strictEqual(actionsBlock.elements[0].value, 'act-pending');
    assert.strictEqual(actionsBlock.elements[0].style, 'primary');
    assert.strictEqual(actionsBlock.elements[1].action_id, 'mail_reject');
    assert.strictEqual(actionsBlock.elements[1].value, 'act-pending');
    assert.strictEqual(actionsBlock.elements[1].style, 'danger');
  });

  it('renders no buttons and a "not found" note for a missing action', () => {
    const digest: MailDigest = {
      summary: 'You have 1 item to review.',
      items: [
        {
          sourceMessageId: '<msg-2@example.com>',
          subject: 'Missing subject',
          from: 'sender2@example.com',
          analysis: 'This proposal id does not exist.',
          proposedActionId: 'act-does-not-exist',
        },
      ],
    };

    const blocks = renderDigestBlocks(digest, store);

    assert.strictEqual(blocks.find((b) => b.type === 'actions'), undefined);
    const section = blocks.find(
      (b) => b.type === 'section' && (b as any).text?.text?.includes('Missing subject'),
    ) as any;
    assert.ok(section);
    assert.match(section.text.text, /action not found/);
  });

  it('renders no buttons and the actual status for a non-pending action', () => {
    store.createProposedAction(baseAction({ actionId: 'act-executed', idempotencyKey: 'idem-executed' }));
    store.markDecided('act-executed', 'approved', 'U123');
    store.markExecuted('act-executed', 'executed');

    const digest: MailDigest = {
      summary: 'You have 1 item to review.',
      items: [
        {
          sourceMessageId: '<msg-3@example.com>',
          subject: 'Executed subject',
          from: 'sender3@example.com',
          analysis: 'Already handled.',
          proposedActionId: 'act-executed',
        },
      ],
    };

    const blocks = renderDigestBlocks(digest, store);

    assert.strictEqual(blocks.find((b) => b.type === 'actions'), undefined);
    const section = blocks.find(
      (b) => b.type === 'section' && (b as any).text?.text?.includes('Executed subject'),
    ) as any;
    assert.ok(section);
    assert.match(section.text.text, /already executed/);
  });

  it('prepends a summary section and dividers between items', () => {
    store.createProposedAction(baseAction({ actionId: 'act-pending-2', idempotencyKey: 'idem-pending-2' }));

    const digest: MailDigest = {
      summary: 'Summary text here.',
      items: [
        {
          sourceMessageId: '<msg-4@example.com>',
          subject: 'A',
          from: 'a@example.com',
          analysis: 'a',
          proposedActionId: 'act-pending-2',
        },
      ],
    };

    const blocks = renderDigestBlocks(digest, store);

    assert.strictEqual(blocks[0].type, 'section');
    assert.strictEqual((blocks[0] as any).text.text, 'Summary text here.');
    assert.strictEqual(blocks[1].type, 'divider');
  });
});
