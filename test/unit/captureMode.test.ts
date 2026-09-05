/**
 * Unit tests for capture mode (`outputFormat: 'json'`) and the additive
 * CLI-restriction flag wiring in SessionManager.spawn().
 *
 * Uses `node test/fixtures/argvEcho.cjs` as a synthetic test binary so the
 * tests are portable across Linux/Windows (unlike the older cmd.exe/bash.exe
 * based suites) and tolerant of the arbitrary flags under test.
 *
 *   node --import tsx --test test/unit/captureMode.test.ts
 */
import { describe, it }   from 'node:test';
import assert             from 'node:assert';
import { SessionManager } from '../../src/cli/runner.js';
import { OutputRouter }   from '../../src/streaming/router.js';
import { spawnProcess, SpawnHandle } from '../../src/cli/processHandle.js';
import { resolve } from 'node:path';
import type { AppConfig, CommandConfig } from '../../src/types.js';
import type { SlackReporter } from '../../src/slack/reporter.js';

// ── stubs ────────────────────────────────────────────────────────────────────

interface ReporterCall { method: string; args: unknown[] }

function makeReporter(calls: ReporterCall[]): SlackReporter {
  const rec = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    return 'ts-1';
  };
  return {
    postMessage:             rec('postMessage'),
    postMessageWithButton:   rec('postMessageWithButton'),
    updateMessage:           rec('updateMessage'),
    updateMessageWithButton: rec('updateMessageWithButton'),
  } as unknown as SlackReporter;
}

const baseConfig = {
  behavior: {
    sessionTimeoutMinutes:    5,
    outputFlushIntervalMs:    50,
    outputMaxCharsPerMessage: 3000,
  },
  envelope: { promptFile: '', promptText: '', activationDelayMs: 0, unclosedTimeoutMs: 1000 },
} as unknown as AppConfig;

/**
 * Synthetic CLI binary: `node test/fixtures/argvEcho.cjs …`.
 * It tolerates arbitrary flags (unlike `node -e`, which rejects unknown ones),
 * writes noise to stderr and its own argv as JSON to stdout.
 */
const ECHO = resolve(process.cwd(), 'test/fixtures/argvEcho.cjs');

const cmd = (over: Partial<CommandConfig>): CommandConfig => ({
  prefix: 'test', binary: process.execPath, args: [ECHO],
  mode: 'one-shot', envelope: false, description: 'test command',
  timeout: false, ...over,
});

/** Waits until predicate is true or the deadline passes */
async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
}

// ── capture mode ─────────────────────────────────────────────────────────────

describe('capture mode (outputFormat: json)', () => {

  it('delivers clean stdout (no stderr contamination) to onJsonResult', async () => {
    const calls: ReporterCall[] = [];
    const results: Array<{ ch: string; ts: string; out: string; code: number }> = [];

    const mgr = new SessionManager(baseConfig, makeReporter(calls),
      async (ch, ts, out, code) => { results.push({ ch, ts, out, code }); });

    await mgr.spawn({
      channelId: 'C1', threadTs: 'T1',
      // The fixture writes NOISE-STDERR to stderr and JSON to stdout.
      command: 'hello-arg',
      config: cmd({ outputFormat: 'json' }),
    });

    await waitFor(() => results.length > 0);

    assert.strictEqual(results.length, 1, 'onJsonResult was not invoked');
    const [r] = results;
    assert.strictEqual(r.ch, 'C1');
    assert.strictEqual(r.ts, 'T1');
    assert.strictEqual(r.code, 0);
    assert.ok(!r.out.includes('NOISE-STDERR'),
      `stderr leaked into captured stdout: ${JSON.stringify(r.out)}`);
    const argv = JSON.parse(r.out.trim()) as string[];
    assert.ok(argv.includes('hello-arg'), `captured argv unexpected: ${r.out}`);

    // Capture mode replaces the completion banner entirely.
    assert.ok(!calls.some((c) => c.method.startsWith('updateMessage')),
      'capture mode should not post the completion banner');
  });

  it('falls back to the normal banner when no onJsonResult is injected', async () => {
    const calls: ReporterCall[] = [];
    const mgr = new SessionManager(baseConfig, makeReporter(calls)); // no callback

    await mgr.spawn({
      channelId: 'C2', threadTs: 'T2',
      command: 'x',
      config: cmd({ outputFormat: 'json' }),
    });

    await waitFor(() => calls.some((c) => c.method === 'updateMessage'));
    assert.ok(calls.some((c) => c.method === 'updateMessage'),
      'expected fallback to the normal banner-update path');
  });

  it('rejects capture mode for interactive (PTY) handles rather than misbehaving', async () => {
    // PtyHandle exposes no separated streams, so onStdout/onStderr are absent.
    const merged = { onData() {}, onExit() {}, write() {}, kill() {} };
    assert.strictEqual((merged as { onStdout?: unknown }).onStdout, undefined);

    const handle = await spawnProcess(process.execPath, [ECHO],
      { mode: 'one-shot', cwd: process.cwd() });
    assert.strictEqual(typeof (handle as SpawnHandle).onStdout, 'function',
      'one-shot handles must expose stdout-only subscription');
    assert.strictEqual(typeof (handle as SpawnHandle).onStderr, 'function');
    handle.kill();
  });
});

// ── regression guard: default (non-capture) path ─────────────────────────────

describe('non-capture mode is unaffected', () => {

  it('still posts the start message and completion banner', async () => {
    const calls: ReporterCall[] = [];
    const mgr = new SessionManager(baseConfig, makeReporter(calls),
      async () => { assert.fail('onJsonResult must not fire without outputFormat: json'); });

    await mgr.spawn({
      channelId: 'C3', threadTs: 'T3',
      command: 'plain-output',
      config: cmd({}),   // no outputFormat
    });

    await waitFor(() => calls.some((c) => c.method === 'updateMessage'
      && String(c.args[2]).includes('Session started')));
    assert.ok(calls.some((c) => c.method === 'postMessage'), 'missing start message');
    // FullStreamer also uses updateMessage for its own output message, so
    // pick the update that targets the session start banner.
    const update = calls.find((c) => c.method === 'updateMessage'
      && String(c.args[2]).includes('Session started'));
    assert.ok(update, `missing completion banner; calls=${JSON.stringify(calls.map((c) => c.method))}`);
    assert.ok(String(update.args[2]).includes('✅ Session complete'),
      `unexpected banner text: ${String(update.args[2])}`);
  });

  it('OutputRouter.capture is false without outputFormat and true with json', () => {
    const opts = {
      sessionId: 'router-test-a', channelId: 'C', threadTs: 'T',
      envelope: false, reporter: makeReporter([]),
      envelopeConfig: { activationDelayMs: 0, unclosedTimeoutMs: 100 },
      streamConfig:   { flushIntervalMs: 50, maxCharsPerMessage: 100 },
    };
    assert.strictEqual(new OutputRouter(opts).capture, false);
    assert.strictEqual(new OutputRouter({ ...opts, sessionId: 'router-test-b', outputFormat: 'json' }).capture, true);
  });
});

// ── spawnArgs flag wiring ────────────────────────────────────────────────────

describe('CLI restriction flags in spawnArgs', () => {

  /** Spawns a node script that prints its own argv, and returns those args */
  async function capturedArgs(over: Partial<CommandConfig>): Promise<string[]> {
    const calls: ReporterCall[] = [];
    const results: string[] = [];
    const mgr = new SessionManager(baseConfig, makeReporter(calls),
      async (_c, _t, out) => { results.push(out); });

    await mgr.spawn({
      channelId: 'C4', threadTs: `T-${Math.random()}`,
      command: 'the-prompt',
      config: cmd({ outputFormat: 'json', ...over }),
    });
    await waitFor(() => results.length > 0);
    assert.strictEqual(results.length, 1, 'process did not produce captured stdout');
    return JSON.parse(results[0].trim()) as string[];
  }

  it('omits every optional flag when the config does not set them', async () => {
    // outputFormat stays 'json' because reading back argv requires capture mode;
    // every other optional flag is unset and must not appear.
    const argv = await capturedArgs({});
    for (const flag of ['--allowedTools', '--disallowedTools', '--permission-mode',
      '--json-schema', '--max-turns', '--max-budget-usd']) {
      assert.ok(!argv.includes(flag), `unexpected ${flag} in argv: ${JSON.stringify(argv)}`);
    }
  });

  it('appends the flags after the prompt, in declaration order', async () => {
    const argv = await capturedArgs({
      allowedTools:    'Bash(mailctl:*)',
      disallowedTools: ['Read', 'Write'],
      permissionMode:  'dontAsk',
      maxTurns:        7,
      maxBudgetUsd:    1.5,
    });

    // Flags come after the prompt/command argument.
    const firstFlag = argv.indexOf('--allowedTools');
    assert.ok(firstFlag > 0, `--allowedTools missing: ${JSON.stringify(argv)}`);

    const tail = argv.slice(firstFlag);
    assert.deepStrictEqual(tail, [
      '--allowedTools', 'Bash(mailctl:*)',
      // repeated once per entry — no comma-joining assumptions
      '--disallowedTools', 'Read',
      '--disallowedTools', 'Write',
      '--permission-mode', 'dontAsk',
      '--output-format', 'json',
      '--max-turns', '7',
      '--max-budget-usd', '1.5',
    ]);
  });
});
