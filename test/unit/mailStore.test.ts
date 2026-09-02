/**
 * Unit tests for MailStore (src/mail/threadStore.ts) — backed by better-sqlite3.
 * Uses a temp DB file per run, cleaned up afterward.
 *
 *   npx tsx --test test/unit/mailStore.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { MailStore } from '../../src/mail/threadStore.js';
import type { MailEnvelope, ProposedAction } from '../../src/mail/types.js';

let dbPath: string;
let store: MailStore;

before(() => {
  dbPath = path.join(os.tmpdir(), `mailstore-test-${crypto.randomUUID()}.db`);
  store = new MailStore(dbPath);
});

after(() => {
  store.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});

const sampleEnvelope: MailEnvelope = {
  id: 'env-1',
  account: 'work',
  folder: 'INBOX',
  messageId: '<msg-1@example.com>',
  inReplyTo: null,
  subject: 'Hello',
  fromAddr: 'sender@example.com',
  toAddrs: ['a@example.com', 'b@example.com'],
  date: '2026-09-01T00:00:00Z',
  rawJson: '{"foo":"bar"}',
};

const sampleAction: Omit<ProposedAction, 'createdAt' | 'decidedAt' | 'decidedBy' | 'executedAt' | 'error' | 'status'> = {
  actionId: 'act-1',
  idempotencyKey: 'idem-1',
  kind: 'archive',
  sourceMessageId: '<msg-1@example.com>',
  paramsJson: JSON.stringify({ kind: 'archive' }),
  slackChannelId: 'C123',
  slackThreadTs: '111.222',
  slackMessageTs: null,
};

describe('MailStore', () => {
  it('creates and gets an envelope round-trip, including toAddrs array', () => {
    store.upsertEnvelope(sampleEnvelope);
    const got = store.getEnvelope('env-1');
    assert.ok(got);
    assert.deepStrictEqual(got, sampleEnvelope);
  });

  it('gets an envelope by messageId', () => {
    const got = store.getEnvelopeByMessageId('<msg-1@example.com>');
    assert.ok(got);
    assert.strictEqual(got?.id, 'env-1');
  });

  it('upsert overwrites an existing envelope with the same id', () => {
    store.upsertEnvelope({ ...sampleEnvelope, subject: 'Updated' });
    const got = store.getEnvelope('env-1');
    assert.strictEqual(got?.subject, 'Updated');
  });

  it('creates and gets a proposed action', () => {
    const id = store.createProposedAction(sampleAction);
    assert.strictEqual(id, 'act-1');
    const got = store.getProposedAction('act-1');
    assert.ok(got);
    assert.strictEqual(got?.status, 'pending');
    assert.strictEqual(got?.idempotencyKey, 'idem-1');
    assert.strictEqual(got?.decidedAt, null);
    assert.strictEqual(got?.executedAt, null);
  });

  it('throws a clear error on duplicate idempotencyKey', () => {
    assert.throws(
      () => store.createProposedAction({ ...sampleAction, actionId: 'act-2' }),
      /idempotencyKey "idem-1" already exists/,
    );
  });

  it('markDecided sets status, decidedAt, decidedBy', () => {
    store.markDecided('act-1', 'approved', 'U123');
    const got = store.getProposedAction('act-1');
    assert.strictEqual(got?.status, 'approved');
    assert.strictEqual(got?.decidedBy, 'U123');
    assert.ok(got?.decidedAt);
  });

  it('markExecuted sets status, executedAt, and error when given', () => {
    store.markExecuted('act-1', 'executed');
    let got = store.getProposedAction('act-1');
    assert.strictEqual(got?.status, 'executed');
    assert.ok(got?.executedAt);
    assert.strictEqual(got?.error, null);

    store.createProposedAction({ ...sampleAction, actionId: 'act-3', idempotencyKey: 'idem-3' });
    store.markExecuted('act-3', 'failed', 'boom');
    got = store.getProposedAction('act-3');
    assert.strictEqual(got?.status, 'failed');
    assert.strictEqual(got?.error, 'boom');
  });

  it('rejects an invalid status via the CHECK constraint when inserted raw', () => {
    const raw = new Database(dbPath);
    assert.throws(() => {
      raw
        .prepare(
          `UPDATE proposed_actions SET status = 'bogus' WHERE action_id = 'act-1'`,
        )
        .run();
    }, /CHECK constraint failed/);
    raw.close();
  });
});
