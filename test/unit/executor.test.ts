/**
 * Unit tests for the mail executor (src/mail/executor.ts) — the only file in
 * the mail-triage feature that performs a real himalaya write.
 *
 *   npx tsx --test test/unit/executor.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import url from 'node:url';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { MailStore } from '../../src/mail/threadStore.js';
import type { MailEnvelope } from '../../src/mail/types.js';
import {
  executeAction,
  buildHimalayaArgs,
  parseActionParams,
  dispatch,
  ExecutorError,
  type Deps,
  type ExecutorStore,
} from '../../src/mail/executor.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '../..');
const SRC_PATH = path.join(REPO_ROOT, 'src/mail/executor.ts');

let tmpDir: string;
let dbPath: string;
let store: MailStore;

const ENVELOPE: MailEnvelope = {
  id: '42',
  account: 'work',
  folder: 'INBOX',
  messageId: '<q1@example.com>',
  inReplyTo: null,
  subject: 'Quarterly report',
  fromAddr: 'alice@example.com',
  toAddrs: ['me@example.com'],
  date: '2026-09-01T10:00:00Z',
  rawJson: '{}',
};

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-test-'));
  dbPath = path.join(tmpDir, 'mail.db');
  store = new MailStore(dbPath);
  store.upsertEnvelope(ENVELOPE);
});

after(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface Recorder {
  calls: Array<{ args: string[]; opts?: { account?: string } }>;
}

function makeDeps(opts: { fail?: Error; delayMs?: number; store?: ExecutorStore } = {}): Deps & Recorder {
  const calls: Array<{ args: string[]; opts?: { account?: string } }> = [];
  return {
    calls,
    store: opts.store ?? store,
    runHimalaya: async (args, o) => {
      calls.push({ args, opts: o });
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail) throw opts.fail;
      return { ok: true };
    },
  };
}

let seq = 0;
/** Inserts a proposed action and optionally approves it. Returns its action id. */
function makeAction(opts: {
  kind: 'archive' | 'move' | 'flag' | 'reply' | 'delete';
  params: unknown;
  approve?: boolean;
  sourceMessageId?: string;
}): string {
  const actionId = crypto.randomUUID();
  store.createProposedAction({
    actionId,
    idempotencyKey: `k-${seq++}-${actionId}`,
    kind: opts.kind,
    sourceMessageId: opts.sourceMessageId ?? ENVELOPE.messageId!,
    paramsJson: JSON.stringify(opts.params),
    slackChannelId: 'C123',
    slackThreadTs: '111.222',
    slackMessageTs: '333.444',
  });
  if (opts.approve !== false) store.markDecided(actionId, 'approved', 'U_HUMAN');
  return actionId;
}

// ---------------------------------------------------------------------------

describe('executor argv construction (per action kind)', () => {
  it('archive → message move to the "archive" mailbox alias', () => {
    assert.deepStrictEqual(buildHimalayaArgs({ kind: 'archive' }, ENVELOPE), [
      'message', 'move', '42', '--from', 'INBOX', '--to', 'archive',
    ]);
  });

  it('move → message move to the params folder', () => {
    assert.deepStrictEqual(buildHimalayaArgs({ kind: 'move', toFolder: 'Receipts' }, ENVELOPE), [
      'message', 'move', '42', '--from', 'INBOX', '--to', 'Receipts',
    ]);
  });

  it('flag add / flag remove', () => {
    assert.deepStrictEqual(buildHimalayaArgs({ kind: 'flag', flag: 'seen', op: 'add' }, ENVELOPE), [
      'flag', 'add', '--flag', 'seen', '42', '--folder', 'INBOX',
    ]);
    assert.deepStrictEqual(buildHimalayaArgs({ kind: 'flag', flag: 'flagged', op: 'remove' }, ENVELOPE), [
      'flag', 'remove', '--flag', 'flagged', '42', '--folder', 'INBOX',
    ]);
  });

  it('reply → message reply --send, with no recipient flags and no --all', () => {
    const args = buildHimalayaArgs({ kind: 'reply', body: 'thanks!' }, ENVELOPE);
    assert.deepStrictEqual(args, [
      'message', 'reply', '42', '--folder', 'INBOX', '--body', 'thanks!', '--send',
    ]);
    for (const forbidden of ['--to', '--cc', '--bcc', '--reply-to', '--all']) {
      assert.ok(!args.includes(forbidden), `reply argv contained ${forbidden}`);
    }
  });

  it('delete → message delete (trash-only, never purge)', () => {
    const args = buildHimalayaArgs({ kind: 'delete' }, ENVELOPE);
    assert.deepStrictEqual(args, ['message', 'delete', '42', '--folder', 'INBOX']);
    assert.ok(!args.includes('--purge') && !args.includes('purge'));
  });
});

describe('executeAction — approved happy path', () => {
  it('archives using the envelope folder/account, with no address anywhere in argv', async () => {
    const actionId = makeAction({ kind: 'archive', params: { kind: 'archive' } });
    const deps = makeDeps();
    const result = await executeAction(actionId, deps);

    assert.strictEqual(result.outcome, 'executed');
    assert.strictEqual(result.success, true);
    assert.strictEqual(deps.calls.length, 1);
    assert.deepStrictEqual(deps.calls[0]!.args, [
      'message', 'move', '42', '--from', 'INBOX', '--to', 'archive',
    ]);
    assert.strictEqual(deps.calls[0]!.opts?.account, 'work');

    // No argument may look like an email address — the recipient never travels
    // through this path at all.
    for (const arg of deps.calls[0]!.args) {
      assert.ok(!arg.includes('@'), `argv contained an address-like token: ${arg}`);
    }
    assert.ok(!deps.calls[0]!.opts!.account!.includes('@'));

    assert.strictEqual(store.getProposedAction(actionId)!.status, 'executed');
  });

  it('carries the stored Slack addressing through to the result', async () => {
    const actionId = makeAction({ kind: 'delete', params: { kind: 'delete' } });
    const result = await executeAction(actionId, makeDeps());
    assert.strictEqual(result.slackChannelId, 'C123');
    assert.strictEqual(result.slackThreadTs, '111.222');
    assert.strictEqual(result.slackMessageTs, '333.444');
  });

  it('reply executes with no --to/--cc/--bcc in the recorded call', async () => {
    const actionId = makeAction({ kind: 'reply', params: { kind: 'reply', body: 'sure thing' } });
    const deps = makeDeps();
    await executeAction(actionId, deps);
    const args = deps.calls[0]!.args;
    for (const forbidden of ['--to', '--cc', '--bcc', '--reply-to', '--all']) {
      assert.ok(!args.includes(forbidden), `recorded reply call contained ${forbidden}`);
    }
    assert.ok(!args.some((a) => a.includes('@')), 'recorded reply call contained an address');
  });

  it('move uses the folder from params, not from anything else', async () => {
    const actionId = makeAction({ kind: 'move', params: { kind: 'move', toFolder: 'Receipts' } });
    const deps = makeDeps();
    await executeAction(actionId, deps);
    assert.deepStrictEqual(deps.calls[0]!.args, [
      'message', 'move', '42', '--from', 'INBOX', '--to', 'Receipts',
    ]);
  });

  it('flag uses the params flag/op', async () => {
    const actionId = makeAction({ kind: 'flag', params: { kind: 'flag', flag: 'flagged', op: 'add' } });
    const deps = makeDeps();
    await executeAction(actionId, deps);
    assert.deepStrictEqual(deps.calls[0]!.args, [
      'flag', 'add', '--flag', 'flagged', '42', '--folder', 'INBOX',
    ]);
  });
});

describe('executeAction — refusals', () => {
  it('refuses a pending action: no himalaya call, no status change', async () => {
    const actionId = makeAction({ kind: 'archive', params: { kind: 'archive' }, approve: false });
    const deps = makeDeps();
    const result = await executeAction(actionId, deps);

    assert.strictEqual(result.outcome, 'skipped');
    assert.strictEqual(result.success, false);
    assert.match(result.reason!, /not "approved"/);
    assert.strictEqual(deps.calls.length, 0);

    const row = store.getProposedAction(actionId)!;
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.executedAt, null);
    assert.strictEqual(row.error, null);
  });

  it('refuses an already-executed action (replayed button click)', async () => {
    const actionId = makeAction({ kind: 'archive', params: { kind: 'archive' } });
    await executeAction(actionId, makeDeps());
    const deps = makeDeps();
    const result = await executeAction(actionId, deps);
    assert.strictEqual(result.outcome, 'skipped');
    assert.strictEqual(deps.calls.length, 0);
  });

  it('refuses a rejected action', async () => {
    const actionId = makeAction({ kind: 'delete', params: { kind: 'delete' }, approve: false });
    store.markDecided(actionId, 'rejected', 'U_HUMAN');
    const deps = makeDeps();
    const result = await executeAction(actionId, deps);
    assert.strictEqual(result.outcome, 'skipped');
    assert.strictEqual(deps.calls.length, 0);
    assert.strictEqual(store.getProposedAction(actionId)!.status, 'rejected');
  });

  it('throws for an unknown action id', async () => {
    await assert.rejects(() => executeAction('no-such-action', makeDeps()), ExecutorError);
  });

  it('marks failed when the source envelope is missing, without calling himalaya', async () => {
    const actionId = makeAction({
      kind: 'archive',
      params: { kind: 'archive' },
      sourceMessageId: '<not-cached@example.com>',
    });
    const deps = makeDeps();
    const result = await executeAction(actionId, deps);

    assert.strictEqual(result.outcome, 'failed');
    assert.strictEqual(deps.calls.length, 0);
    assert.match(result.reason!, /source envelope not found in local store/);

    const row = store.getProposedAction(actionId)!;
    assert.strictEqual(row.status, 'failed');
    assert.match(row.error!, /source envelope not found in local store/);
  });

  it('marks failed for malformed params, without calling himalaya', async () => {
    const actionId = makeAction({ kind: 'move', params: { kind: 'move' } });
    const deps = makeDeps();
    const result = await executeAction(actionId, deps);
    assert.strictEqual(result.outcome, 'failed');
    assert.strictEqual(deps.calls.length, 0);
    assert.match(store.getProposedAction(actionId)!.error!, /toFolder/);
  });
});

describe('executeAction — himalaya failure', () => {
  it('marks the action failed and stores the error message', async () => {
    const actionId = makeAction({ kind: 'archive', params: { kind: 'archive' } });
    const deps = makeDeps({ fail: new Error('himalaya command failed: IMAP timeout') });
    const result = await executeAction(actionId, deps);

    assert.strictEqual(result.outcome, 'failed');
    assert.strictEqual(result.success, false);
    assert.match(result.reason!, /IMAP timeout/);

    const row = store.getProposedAction(actionId)!;
    assert.strictEqual(row.status, 'failed');
    assert.match(row.error!, /IMAP timeout/);
  });
});

describe('parseActionParams re-validates the stored row', () => {
  it('rejects a params kind that disagrees with the action kind', () => {
    assert.throws(() => parseActionParams('archive', JSON.stringify({ kind: 'reply', body: 'x' })), ExecutorError);
  });

  it('rejects an invalid flag or op', () => {
    assert.throws(() => parseActionParams('flag', JSON.stringify({ flag: 'bogus', op: 'add' })), /invalid flag/);
    assert.throws(() => parseActionParams('flag', JSON.stringify({ flag: 'seen', op: 'toggle' })), /invalid flag op/);
  });

  it('rejects non-JSON', () => {
    assert.throws(() => parseActionParams('archive', 'not json'), /not valid JSON/);
  });

  it('ignores any extra recipient-looking field smuggled into params_json', () => {
    const params = parseActionParams(
      'reply',
      JSON.stringify({ kind: 'reply', body: 'hi', to: 'evil@example.com', cc: 'evil2@example.com' }),
    );
    assert.deepStrictEqual(params, { kind: 'reply', body: 'hi' });
    const args = buildHimalayaArgs(params, ENVELOPE);
    assert.ok(!args.some((a) => a.includes('evil@example.com')));
  });
});

// ---------------------------------------------------------------------------
// The race condition
// ---------------------------------------------------------------------------

describe('cross-process execution race', () => {
  it('claimForExecution succeeds exactly once across two separate DB connections', () => {
    const actionId = makeAction({ kind: 'archive', params: { kind: 'archive' } });
    const a = new MailStore(dbPath);
    const b = new MailStore(dbPath);
    try {
      const results = [a.claimForExecution(actionId), b.claimForExecution(actionId)];
      assert.deepStrictEqual(results, [true, false]);
    } finally {
      a.close();
      b.close();
    }
  });

  it('never claims an action that is not approved', () => {
    const actionId = makeAction({ kind: 'archive', params: { kind: 'archive' }, approve: false });
    assert.strictEqual(store.claimForExecution(actionId), false);
  });

  it('two concurrent executeAction calls on separate connections run himalaya once', async () => {
    const actionId = makeAction({ kind: 'archive', params: { kind: 'archive' } });
    const a = new MailStore(dbPath);
    const b = new MailStore(dbPath);
    const depsA = makeDeps({ store: a, delayMs: 25 });
    const depsB = makeDeps({ store: b, delayMs: 25 });
    try {
      const [ra, rb] = await Promise.all([
        executeAction(actionId, depsA),
        executeAction(actionId, depsB),
      ]);
      assert.strictEqual(
        depsA.calls.length + depsB.calls.length,
        1,
        'himalaya was invoked more than once for one action',
      );
      const outcomes = [ra.outcome, rb.outcome].sort();
      assert.deepStrictEqual(outcomes, ['executed', 'skipped']);
    } finally {
      a.close();
      b.close();
    }
  });

  it('two genuinely concurrent OS processes execute the action exactly once', async () => {
    const actionId = makeAction({ kind: 'archive', params: { kind: 'archive' } });
    const witness = path.join(tmpDir, `witness-${actionId}.log`);

    // A tiny harness that runs the *real* executeAction against the *real*
    // shared SQLite file, with himalaya stubbed out to append one line to a
    // witness file. Two of these are spawned simultaneously — the actual
    // threat model: two rapid Slack button clicks, two `executor.js` processes.
    const harness = path.join(tmpDir, 'harness.mts');
    fs.writeFileSync(
      harness,
      `
import fs from 'node:fs';
import { MailStore } from ${JSON.stringify(url.pathToFileURL(path.join(REPO_ROOT, 'src/mail/threadStore.ts')).href)};
import { executeAction } from ${JSON.stringify(url.pathToFileURL(SRC_PATH).href)};

const [dbPath, actionId, witness] = process.argv.slice(2);
const store = new MailStore(dbPath);
const result = await executeAction(actionId, {
  store,
  runHimalaya: async (args) => {
    fs.appendFileSync(witness, JSON.stringify(args) + '\\n');
    await new Promise((r) => setTimeout(r, 150));
    return {};
  },
});
store.close();
process.stdout.write(JSON.stringify({ outcome: result.outcome }));
`,
      'utf8',
    );

    const run = (): Promise<string> =>
      new Promise((resolve, reject) => {
        execFile(
          process.execPath,
          ['--import', 'tsx', harness, dbPath, actionId, witness],
          { cwd: REPO_ROOT },
          (err, stdout, stderr) => (err ? reject(new Error(`${String(err)}\n${stderr}`)) : resolve(stdout)),
        );
      });

    const [out1, out2] = await Promise.all([run(), run()]);
    const outcomes = [JSON.parse(out1).outcome, JSON.parse(out2).outcome].sort();
    assert.deepStrictEqual(outcomes, ['executed', 'skipped']);

    const lines = fs.readFileSync(witness, 'utf8').trim().split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1, `himalaya ran ${lines.length} times across two processes`);
    assert.deepStrictEqual(JSON.parse(lines[0]!), [
      'message', 'move', '42', '--from', 'INBOX', '--to', 'archive',
    ]);
    assert.strictEqual(store.getProposedAction(actionId)!.status, 'executed');
  });
});

// ---------------------------------------------------------------------------

describe('executor CLI dispatch', () => {
  it('rejects anything but `execute <action-id>`', async () => {
    for (const argv of [[], ['run', 'x'], ['execute'], ['execute', 'a', 'b']]) {
      await assert.rejects(() => dispatch(argv, makeDeps()), ExecutorError);
    }
  });
});

describe('executor static safety checks', () => {
  const source = fs.readFileSync(SRC_PATH, 'utf8');
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  // Note: `'--to'` is legitimately present as the *folder* target of
  // `message move`; it is never a mail recipient. The reply argv is asserted
  // flag-by-flag above instead.
  it('contains no recipient flag literal in executable code', () => {
    for (const literal of ["'--cc'", "'--bcc'", "'--reply-to'", "'--all'", "'message send'"]) {
      assert.ok(!withoutComments.includes(literal), `source contains ${literal}`);
    }
  });

  it('never reads a recipient-shaped field out of params', () => {
    // `o.toFolder` is a folder name, not an address — hence the word boundary.
    for (const field of ['to', 'cc', 'bcc', 'recipient', 'replyTo', 'from']) {
      const re = new RegExp(`\\b(?:o|params|raw)\\.${field}\\b`);
      assert.ok(!re.test(withoutComments), `source reads a recipient-shaped field .${field}`);
    }
  });
});
