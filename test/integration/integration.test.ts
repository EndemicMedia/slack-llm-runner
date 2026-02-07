/**
 * Integration test: spawn → OutputRouter → output capture
 * Simulates the exact flow the bot uses for one-shot commands.
 */
import { describe, it }     from 'node:test';
import assert               from 'node:assert';
import { spawnProcess }     from '../../src/cli/processHandle.js';
import { OutputRouter }     from '../../src/streaming/router.js';
import { createLogger }     from '../../src/utils/logger.js';
import { resolve }          from 'path';
import { existsSync, readFileSync, rmSync } from 'fs';

const logger = createLogger('IntegrationTest');

describe('Integration – spawn → OutputRouter → log capture', () => {

  it('one-shot command output is captured to log file', async () => {
    const sessionId = 'integration_test_' + Date.now();
    const logPath   = resolve(process.cwd(), 'logs', 'sessions', `${sessionId}.log`);

    // Clean up any previous test file
    if (existsSync(logPath)) rmSync(logPath);

    // Create output router (log + streamer, like in runner.ts)
    const router = new OutputRouter({
      sessionId,
      channelId:  'TEST_CHANNEL',
      threadTs:   'TEST_THREAD',
      envelope:   false,  // one-shot mode uses full-output, not envelope
      reporter:   {
        postMessage:    async () => 'mock-ts',
        updateMessage:  async () => {},
        uploadFile:     async () => {},
      } as any,
      envelopeConfig: {
        activationDelayMs:   0,
        unclosedTimeoutMs:   5000,
      },
      streamConfig: {
        flushIntervalMs:     100,
        maxCharsPerMessage:  3500,
      },
    });

    // Start the router (opens log file)
    await router.start();

    // Spawn the command: bash.exe -c 'echo hello-world'
    const handle = await spawnProcess('bash.exe', ['-c', 'echo hello-world'], {
      mode: 'one-shot',
      cwd:  process.cwd(),
    });

    // Wire up output routing (the bot does this in runner.ts)
    let capturedOutput = '';
    handle.onData((data) => {
      capturedOutput += data;
      router.push(data);
    });

    // Wait for exit
    let exitCode = -999;
    await new Promise<void>((resolve) => {
      handle.onExit((code) => {
        exitCode = code;
        void router.finish(code).then(() => resolve());
      });
    });

    // Verify
    assert.strictEqual(exitCode, 0, `Expected exit code 0, got ${exitCode}`);
    assert.ok(capturedOutput.length > 0, `No output captured in memory: got "${capturedOutput}"`);
    assert.ok(capturedOutput.includes('hello-world'), `Output missing "hello-world": ${JSON.stringify(capturedOutput)}`);

    // Verify log file was written
    assert.ok(existsSync(logPath), `Log file not created: ${logPath}`);

    const logContent = readFileSync(logPath, 'utf8');
    assert.ok(logContent.includes('hello-world'), `Log file missing output: ${JSON.stringify(logContent)}`);
    assert.ok(logContent.includes('Session started'), `Log file missing start marker`);
    assert.ok(logContent.includes('exit code: 0'), `Log file missing exit code`);

    logger.info('✅ Integration test passed: output captured to log');
  });

  it('E2E bot flow: data events tracked and logged', async () => {
    const sessionId = 'e2e_test_' + Date.now();
    const logPath = resolve(process.cwd(), 'logs', 'sessions', `${sessionId}.log`);

    if (existsSync(logPath)) rmSync(logPath);

    const router = new OutputRouter({
      sessionId,
      channelId: 'TEST_CHANNEL',
      threadTs: 'TEST_THREAD',
      envelope: false,
      reporter: {
        postMessage: async () => 'mock-ts',
        updateMessage: async () => {},
        uploadFile: async () => {},
      } as any,
      envelopeConfig: { activationDelayMs: 0, unclosedTimeoutMs: 5000 },
      streamConfig: { flushIntervalMs: 100, maxCharsPerMessage: 3500 },
    });

    await router.start();

    const handle = await spawnProcess('bash.exe', ['-c', 'echo E2E_TEST_OUTPUT'], {
      mode: 'one-shot',
      cwd: process.cwd(),
    });

    let dataEventsFired = 0;
    handle.onData((data) => {
      dataEventsFired++;
      router.push(data);
    });

    await new Promise<void>((resolve) => {
      handle.onExit((code) => {
        void router.finish(code).then(() => resolve());
      });
    });

    await new Promise(r => setTimeout(r, 500));

    assert.ok(dataEventsFired > 0, `onData should have fired, but fired ${dataEventsFired} times`);
    assert.ok(existsSync(logPath), `Log file should exist: ${logPath}`);

    const logContent = readFileSync(logPath, 'utf8');
    assert.ok(logContent.includes('Session started'), 'Log should have start marker');
    assert.ok(logContent.includes('E2E_TEST_OUTPUT'), `Log should contain output. Got: ${JSON.stringify(logContent)}`);
    assert.ok(logContent.includes('exit code: 0'), 'Log should have exit code');
  });

});
