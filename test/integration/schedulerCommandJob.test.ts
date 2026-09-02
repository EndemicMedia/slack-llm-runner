/**
 * Integration test: Scheduler applies Authorizer + checkCommand to
 * `kind: 'command'` jobs, and leaves `kind: 'shell'` jobs untouched.
 */
import { describe, it }             from 'node:test';
import assert                       from 'node:assert';
import { Scheduler }                from '../../src/scheduler/scheduler.js';
import { Authorizer }               from '../../src/security/authorizer.js';
import type { AppConfig, CommandConfig, JobDefinition, SessionSpawnOptions } from '../../src/types.js';

const CHANNEL_OK    = 'C_ALLOWED';
const CHANNEL_DENIED = 'C_DENIED';

const mailTriage: CommandConfig = {
  prefix:      'mail-triage',
  binary:      'claude',
  mode:        'one-shot',
  envelope:    false,
  description: 'Mail triage',
};

function makeConfig(jobs: JobDefinition[]): AppConfig {
  return {
    auth: {
      allowedUserIds: ['U1'],
      rules: [
        { channels: [CHANNEL_OK],     users: ['*'], allowed_prefixes: ['mail-triage'] },
        { channels: [CHANNEL_DENIED], users: ['*'], allowed_prefixes: ['other'] },
      ],
    },
    commands: [mailTriage],
    jobs,
  } as unknown as AppConfig;
}

interface Harness {
  scheduler: Scheduler;
  spawns:    SessionSpawnOptions[];
  posts:     Array<{ channel: string; text: string; threadTs?: string }>;
}

function harness(jobs: JobDefinition[]): Harness {
  const spawns: SessionSpawnOptions[] = [];
  const posts:  Array<{ channel: string; text: string; threadTs?: string }> = [];

  const config   = makeConfig(jobs);
  const reporter = {
    postMessage: async (channel: string, text: string, threadTs?: string) => {
      posts.push({ channel, text, threadTs });
      return 'THREAD_TS';
    },
  } as any;
  const runner = {
    spawn: async (opts: SessionSpawnOptions) => { spawns.push(opts); },
  } as any;

  const scheduler = new Scheduler(config, reporter, runner, new Authorizer(config));
  return { scheduler, spawns, posts };
}

/** fire() is private — invoke it directly, bypassing cron timing */
const fire = (h: Harness, job: JobDefinition) =>
  (h.scheduler as any).fire(job) as Promise<void>;

describe('Scheduler – kind: "command" authorization', () => {

  it('rejects a command job whose prefix is not allowed in the channel', async () => {
    const job: JobDefinition = {
      name: 'triage', cron: '0 * * * *', command: '', channel: CHANNEL_DENIED,
      kind: 'command', commandPrefix: 'mail-triage', commandArgs: 'review inbox',
    };
    const h = harness([job]);
    await fire(h, job);

    assert.strictEqual(h.spawns.length, 0, 'runner.spawn must not be called');
    assert.ok(h.posts.some((p) => /not authorized/i.test(p.text)));
  });

  it('rejects a command job whose args trip the blocklist', async () => {
    const job: JobDefinition = {
      name: 'triage', cron: '0 * * * *', command: '', channel: CHANNEL_OK,
      kind: 'command', commandPrefix: 'mail-triage', commandArgs: 'please run rm -rf / now',
    };
    const h = harness([job]);
    await fire(h, job);

    assert.strictEqual(h.spawns.length, 0, 'runner.spawn must not be called');
    assert.ok(h.posts.some((p) => /blocked/i.test(p.text)));
  });

  it('rejects a command job with an unknown command prefix', async () => {
    const job: JobDefinition = {
      name: 'triage', cron: '0 * * * *', command: '', channel: CHANNEL_OK,
      kind: 'command', commandPrefix: 'does-not-exist', commandArgs: 'hello',
    };
    const h = harness([job]);
    await fire(h, job);

    assert.strictEqual(h.spawns.length, 0);
    assert.ok(h.posts.some((p) => /unknown command prefix/i.test(p.text)));
  });

  it('spawns an authorized, unblocked command job with the real CommandConfig', async () => {
    const job: JobDefinition = {
      name: 'triage', cron: '0 * * * *', command: '', channel: CHANNEL_OK,
      kind: 'command', commandPrefix: 'mail-triage', commandArgs: 'review inbox',
      cwd: '/work',
    };
    const h = harness([job]);
    await fire(h, job);

    assert.strictEqual(h.spawns.length, 1);
    const opts = h.spawns[0]!;
    assert.strictEqual(opts.channelId, CHANNEL_OK);
    assert.strictEqual(opts.threadTs, 'THREAD_TS');
    assert.strictEqual(opts.command, 'review inbox');
    assert.strictEqual(opts.cwd, '/work');
    assert.deepStrictEqual(opts.config, mailTriage);
  });
});

describe('Scheduler – shell jobs (backward compatibility)', () => {

  it('a job with kind omitted still spawns through the platform shell', async () => {
    const job: JobDefinition = {
      name: 'legacy', cron: '0 * * * *', command: 'echo hi', channel: CHANNEL_DENIED,
    };
    const h = harness([job]);
    await fire(h, job);

    assert.strictEqual(h.spawns.length, 1, 'shell jobs are unaffected by authorization');
    const opts = h.spawns[0]!;
    assert.strictEqual(opts.command, 'echo hi');
    assert.strictEqual(opts.config.prefix, 'legacy');
    assert.strictEqual(opts.config.mode, 'one-shot');
    assert.strictEqual(opts.config.envelope, false);
    const expected = process.platform === 'win32'
      ? { binary: 'cmd',  args: ['/c'] }
      : { binary: 'bash', args: ['-c'] };
    assert.strictEqual(opts.config.binary, expected.binary);
    assert.deepStrictEqual(opts.config.args, expected.args);
  });

  it('an explicit kind: "shell" job behaves identically', async () => {
    const job: JobDefinition = {
      name: 'legacy2', cron: '0 * * * *', command: 'echo hi', channel: CHANNEL_DENIED,
      kind: 'shell',
    };
    const h = harness([job]);
    await fire(h, job);

    assert.strictEqual(h.spawns.length, 1);
    assert.strictEqual(h.spawns[0]!.command, 'echo hi');
  });
});
