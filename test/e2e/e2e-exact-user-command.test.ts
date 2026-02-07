/**
 * E2E test with EXACT user command format
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnProcess } from '../../src/cli/processHandle.js';
import { OutputRouter } from '../../src/streaming/router.js';
import { existsSync, readFileSync, rmSync } from 'fs';
import { resolve } from 'path';

describe('E2E with exact user commands', () => {

  ['echo FINAL_TEST', 'echo DIAGNOSTIC_TEST_2', 'echo DIAGNOSTIC_TEST_3'].forEach((userCommand) => {
    it(`handles: run: ${userCommand}`, async () => {
      const sessionId = `e2e_${userCommand.replace(/ /g, '_')}_${Date.now()}`;
      const logPath = resolve(process.cwd(), 'logs', 'sessions', `${sessionId}.log`);

      if (existsSync(logPath)) rmSync(logPath);

      // Simulate exact bot flow
      const router = new OutputRouter({
        sessionId,
        channelId: 'C0ACQMYN1C7',
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

      // Construct args exactly like runner.ts does
      const cmdConfig = { binary: 'bash.exe', args: ['-c'] };
      const spawnArgs = [...(cmdConfig.args ?? []), userCommand];

      console.log(`[TEST] Command: bash.exe ${spawnArgs.map(a => JSON.stringify(a)).join(' ')}`);

      const handle = await spawnProcess(cmdConfig.binary, spawnArgs, {
        mode: 'one-shot',
        cwd: process.cwd(),
      });

      let dataCount = 0;
      handle.onData((data) => {
        dataCount++;
        console.log(`[TEST] Data event ${dataCount}: ${data.length} bytes`);
        router.push(data);
      });

      await new Promise<void>((resolve) => {
        handle.onExit((exitCode) => {
          void router.finish(exitCode).then(() => resolve());
        });
      });

      await new Promise(r => setTimeout(r, 300));

      const logContent = readFileSync(logPath, 'utf8');
      console.log(`[TEST] Log content (${logContent.length} chars):\n${logContent}`);

      assert.ok(dataCount > 0, `Should have data events, got ${dataCount}`);
      assert.ok(logContent.includes(userCommand.split(' ')[1]),
        `Output should contain "${userCommand.split(' ')[1]}", got: ${JSON.stringify(logContent)}`);
    });
  });

});
