/**
 * Unit tests for mailctl (src/mail/mailctl.ts) — the security boundary for the
 * mail-triage feature.
 *
 *   npx tsx --test test/unit/mailctl.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import url from 'node:url';
import crypto from 'node:crypto';
import { MailStore } from '../../src/mail/threadStore.js';
import type { MailEnvelope } from '../../src/mail/types.js';
import {
  cmdList,
  cmdSearch,
  cmdRead,
  cmdThread,
  cmdContext,
  cmdPropose,
  dispatch,
  parseArgs,
  mapEnvelope,
  buildActionParams,
  SUBCOMMANDS,
  VALID_KINDS,
  MailctlError,
  type Deps,
} from '../../src/mail/mailctl.js';

const SRC_PATH = path.join(
  path.dirname(url.fileURLToPath(import.meta.url)),
  '../../src/mail/mailctl.ts',
);

let dbPath: string;
let store: MailStore;

before(() => {
  dbPath = path.join(os.tmpdir(), `mailctl-test-${crypto.randomUUID()}.db`);
  store = new MailStore(dbPath);
});

after(() => {
  store.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});

interface Recorder {
  calls: Array<{ args: string[]; opts?: { account?: string } }>;
}

function makeDeps(result: unknown = [], today = '2026-09-02'): Deps & Recorder {
  const calls: Array<{ args: string[]; opts?: { account?: string } }> = [];
  return {
    calls,
    store,
    today: () => today,
    runHimalaya: async (args, opts) => {
      calls.push({ args, opts });
      return result;
    },
  };
}

const HIMALAYA_ENVELOPE = {
  id: '42',
  subject: 'Quarterly report',
  from: { name: 'Alice', addr: 'alice@example.com' },
  to: [{ addr: 'me@example.com' }],
  date: '2026-09-01T10:00:00Z',
  'message-id': '<q1@example.com>',
  'in-reply-to': null,
  'has-attachment': false,
};

// ---------------------------------------------------------------------------

describe('mailctl subcommand surface', () => {
  it('exposes exactly the six planned subcommands and no others', () => {
    assert.deepStrictEqual(
      [...SUBCOMMANDS].sort(),
      ['context', 'list', 'propose', 'read', 'search', 'thread'],
    );
  });

  it('rejects an unknown subcommand', async () => {
    await assert.rejects(() => dispatch(['send'], makeDeps()), MailctlError);
  });
});

describe('mailctl read-only himalaya argv construction', () => {
  it('list builds `envelope list` argv with folder and page-size', async () => {
    const deps = makeDeps([HIMALAYA_ENVELOPE]);
    await cmdList(['--folder', 'INBOX', '--limit', '5', '--account', 'work'], deps);
    assert.deepStrictEqual(deps.calls[0]!.args, [
      'envelope', 'list', '--folder', 'INBOX', '--page-size', '5',
    ]);
    assert.strictEqual(deps.calls[0]!.opts?.account, 'work');
  });

  it('list defaults to the inbox folder and omits page-size', async () => {
    const deps = makeDeps([HIMALAYA_ENVELOPE]);
    await cmdList([], deps);
    assert.deepStrictEqual(deps.calls[0]!.args, ['envelope', 'list', '--folder', 'inbox']);
  });

  it('list upserts mapped envelopes into the store', async () => {
    const deps = makeDeps([HIMALAYA_ENVELOPE]);
    await cmdList(['--account', 'work'], deps);
    const got = store.getEnvelopeByMessageId('<q1@example.com>');
    assert.ok(got);
    assert.strictEqual(got.id, '42');
    assert.strictEqual(got.fromAddr, 'alice@example.com');
    assert.deepStrictEqual(got.toAddrs, ['me@example.com']);
    assert.strictEqual(got.subject, 'Quarterly report');
  });

  it('search builds `envelope search` argv with the query', async () => {
    const deps = makeDeps({ envelopes: [] });
    await cmdSearch(['from alice', '--folder', 'Archive'], deps);
    assert.deepStrictEqual(deps.calls[0]!.args, [
      'envelope', 'search', 'from alice', '--folder', 'Archive',
    ]);
  });

  it('read builds `message read` argv and NEVER passes --seen', async () => {
    const deps = makeDeps({ body: 'hi' });
    await cmdRead(['42', '--folder', 'INBOX'], deps);
    assert.deepStrictEqual(deps.calls[0]!.args, ['message', 'read', '42', '--folder', 'INBOX']);
    assert.ok(!deps.calls[0]!.args.includes('--seen'));
  });

  it('context reads the message and returns sender history without extra writes', async () => {
    const deps = makeDeps({ 'message-id': '<q1@example.com>', body: 'hi' });
    const out = (await cmdContext(['42'], deps)) as { fromAddr: string | null };
    assert.deepStrictEqual(deps.calls[0]!.args, ['message', 'read', '42', '--folder', 'inbox']);
    assert.strictEqual(out.fromAddr, 'alice@example.com');
  });

  it('rejects a recipient flag on every read subcommand', async () => {
    for (const fn of [cmdList, cmdSearch, cmdRead, cmdThread, cmdContext]) {
      await assert.rejects(
        () => fn(['x', '--to', 'evil@example.com'], makeDeps()),
        /unknown option --to/,
      );
    }
  });
});

describe('mailctl envelope mapping', () => {
  it('maps kebab-case himalaya fields into camelCase MailEnvelope', () => {
    const env = mapEnvelope(
      { ...HIMALAYA_ENVELOPE, 'in-reply-to': '<root@example.com>' },
      'work',
      'inbox',
    );
    assert.ok(env);
    assert.strictEqual(env.messageId, '<q1@example.com>');
    assert.strictEqual(env.inReplyTo, '<root@example.com>');
    assert.strictEqual(env.account, 'work');
  });

  it('handles plain-string from/to addresses', () => {
    const env = mapEnvelope({ id: 7, from: 'bob@example.com', to: 'me@example.com' }, 'work', 'inbox');
    assert.strictEqual(env?.fromAddr, 'bob@example.com');
    assert.deepStrictEqual(env?.toAddrs, ['me@example.com']);
  });
});

describe('mailctl propose — never touches the network', () => {
  const baseArgs = ['--channel', 'C123', '--thread', '111.222'];

  it('does not call runHimalaya for any of the five valid kinds', async () => {
    const kindArgs: Record<string, string[]> = {
      archive: [],
      delete: [],
      move: ['--folder', 'Archive'],
      flag: ['--flag', 'seen', '--op', 'add'],
      reply: ['--body', 'thanks!'],
    };
    for (const kind of VALID_KINDS) {
      const deps = makeDeps();
      const out = (await cmdPropose(
        ['--kind', kind, '--source-message-id', `<${kind}-net@example.com>`, ...kindArgs[kind]!, ...baseArgs],
        deps,
      )) as { action_id: string };
      assert.strictEqual(deps.calls.length, 0, `propose(${kind}) called himalaya`);
      assert.match(out.action_id, /^[0-9a-f-]{36}$/);
    }
  });

  it('produces ActionParams with no recipient field for any kind', async () => {
    const cases: Array<[string, string[]]> = [
      ['archive', []],
      ['delete', []],
      ['move', ['--folder', 'Archive']],
      ['flag', ['--flag', 'flagged', '--op', 'remove']],
      ['reply', ['--body', 'ok']],
    ];
    const forbidden = ['to', 'recipient', 'cc', 'bcc', 'toAddr', 'to_addr', 'from'];
    for (const [kind, extra] of cases) {
      const params = buildActionParams(kind, Object.fromEntries(
        extra.reduce<Array<[string, string]>>((acc, v, i, arr) => {
          if (i % 2 === 0) acc.push([v.replace(/^--/, ''), arr[i + 1]!]);
          return acc;
        }, []),
      ));
      const serialized = JSON.stringify(params);
      for (const key of Object.keys(params)) {
        assert.ok(!forbidden.includes(key), `${kind} params exposed forbidden key ${key}`);
      }
      assert.ok(!/"(to|cc|bcc|recipient)"\s*:/.test(serialized), `${kind} serialized a recipient`);
    }
  });

  it('has no recipient-supplying flag in propose argument parsing', async () => {
    for (const flag of ['--to', '--recipient', '--cc', '--bcc', '--reply-to', '--from']) {
      await assert.rejects(
        () =>
          cmdPropose(
            ['--kind', 'reply', '--source-message-id', '<x@example.com>', '--body', 'b', flag, 'evil@example.com', ...baseArgs],
            makeDeps(),
          ),
        new RegExp(`unknown option ${flag}`),
      );
    }
  });

  it('rejects an invalid --kind, including `send`', async () => {
    for (const kind of ['send', 'forward', 'purge', '']) {
      await assert.rejects(
        () => cmdPropose(['--kind', kind, '--source-message-id', '<x@example.com>', ...baseArgs], makeDeps()),
        (err: unknown) => err instanceof MailctlError,
        `kind "${kind}" was not rejected`,
      );
    }
  });

  it('requires kind-specific params', async () => {
    await assert.rejects(
      () => cmdPropose(['--kind', 'move', '--source-message-id', '<x@example.com>', ...baseArgs], makeDeps()),
      /--folder is required/,
    );
    await assert.rejects(
      () => cmdPropose(['--kind', 'reply', '--source-message-id', '<x@example.com>', ...baseArgs], makeDeps()),
      /--body is required/,
    );
    await assert.rejects(
      () =>
        cmdPropose(
          ['--kind', 'flag', '--source-message-id', '<x@example.com>', '--flag', 'bogus', '--op', 'add', ...baseArgs],
          makeDeps(),
        ),
      /invalid --flag/,
    );
  });

  it('is idempotent for the same message + kind + day', async () => {
    const args = ['--kind', 'archive', '--source-message-id', '<idem@example.com>', ...baseArgs];
    const first = (await cmdPropose(args, makeDeps(undefined, '2026-09-02'))) as { action_id: string };
    const second = (await cmdPropose(args, makeDeps(undefined, '2026-09-02'))) as { action_id: string };
    assert.strictEqual(second.action_id, first.action_id);

    // A different day produces a distinct action.
    const nextDay = (await cmdPropose(args, makeDeps(undefined, '2026-09-03'))) as { action_id: string };
    assert.notStrictEqual(nextDay.action_id, first.action_id);
  });

  it('persists a row whose params_json contains no recipient', async () => {
    const out = (await cmdPropose(
      ['--kind', 'reply', '--source-message-id', '<persist@example.com>', '--body', 'sure', ...baseArgs],
      makeDeps(),
    )) as { action_id: string };
    const row = store.getProposedAction(out.action_id);
    assert.ok(row);
    assert.strictEqual(row.status, 'pending');
    assert.deepStrictEqual(JSON.parse(row.paramsJson), { kind: 'reply', body: 'sure' });
    assert.ok(!/@/.test(row.paramsJson));
  });
});

describe('mailctl thread reconstruction (local store only)', () => {
  const chain: MailEnvelope[] = [
    {
      id: 't1', account: 'work', folder: 'inbox',
      messageId: '<root@example.com>', inReplyTo: null,
      subject: 'Root', fromAddr: 'alice@example.com', toAddrs: [],
      date: '2026-08-01T00:00:00Z', rawJson: '{}',
    },
    {
      id: 't2', account: 'work', folder: 'inbox',
      messageId: '<mid@example.com>', inReplyTo: '<root@example.com>',
      subject: 'Re: Root', fromAddr: 'bob@example.com', toAddrs: [],
      date: '2026-08-02T00:00:00Z', rawJson: '{}',
    },
    {
      id: 't3', account: 'work', folder: 'inbox',
      messageId: '<leaf@example.com>', inReplyTo: '<mid@example.com>',
      subject: 'Re: Root', fromAddr: 'alice@example.com', toAddrs: [],
      date: '2026-08-03T00:00:00Z', rawJson: '{}',
    },
  ];

  before(() => {
    for (const env of chain) store.upsertEnvelope(env);
  });

  it('walks the in-reply-to chain back to the root, in order', async () => {
    const deps = makeDeps();
    const out = (await cmdThread(['<leaf@example.com>'], deps)) as {
      count: number; thread: MailEnvelope[];
    };
    assert.strictEqual(deps.calls.length, 0, 'thread made a himalaya call');
    assert.strictEqual(out.count, 3);
    assert.deepStrictEqual(out.thread.map((e) => e.messageId), [
      '<root@example.com>', '<mid@example.com>', '<leaf@example.com>',
    ]);
  });

  it('errors clearly when the message is not cached locally', async () => {
    await assert.rejects(
      () => cmdThread(['<missing@example.com>'], makeDeps()),
      /not in the local store/,
    );
  });
});

describe('mailctl static safety checks', () => {
  const source = fs.readFileSync(SRC_PATH, 'utf8');
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('contains no himalaya write subcommand literals', () => {
    for (const literal of [
      'message reply', 'message delete', 'message move', 'message send',
      'flag add', 'flag remove', 'flag set', '--seen',
    ]) {
      assert.ok(!withoutComments.includes(literal), `source contains write literal "${literal}"`);
    }
  });

  it('contains no recipient flag literal', () => {
    for (const literal of ["'to'", "'recipient'", "'cc'", "'bcc'", '--to ', '--recipient']) {
      assert.ok(
        !withoutComments.includes(literal),
        `source contains recipient literal ${literal}`,
      );
    }
  });
});

describe('parseArgs', () => {
  it('supports --key=value and rejects a flag missing its value', () => {
    assert.deepStrictEqual(parseArgs(['--folder=INBOX'], ['folder']).flags, { folder: 'INBOX' });
    assert.throws(() => parseArgs(['--folder'], ['folder']), /requires a value/);
  });
});
