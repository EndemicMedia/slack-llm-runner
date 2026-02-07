/**
 * Full integration test: Emulate real Slack Socket Mode message flow
 * Message → CommandRouter → SessionManager → spawn → output capture
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync, rmSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { loadConfig } from '../../src/utils/config.js';
import { SlackReporter } from '../../src/slack/reporter.js';
import { SessionManager } from '../../src/cli/runner.js';
import { Authorizer } from '../../src/security/authorizer.js';
import { CommandRouter } from '../../src/commands/router.js';

describe('Slack Integration Test - Full message flow', () => {

  it('Slack message → command execution → output captured in log', async () => {
    // Load real config
    const config = loadConfig();

    // Mock reporter
    let postedMessages: { channelId: string; text: string; ts?: string }[] = [];
    const mockReporter = {
      postMessage: async (channelId: string, text: string, threadTs?: string) => {
        console.log(`[SLACK] Posted to ${channelId}: "${text}"`);
        postedMessages.push({ channelId, text, ts: threadTs });
        return 'mock-ts-' + Date.now();
      },
      updateMessage: async (channelId: string, ts: string, text: string) => {
        console.log(`[SLACK] Updated message: "${text.substring(0, 50)}..."`);
      },
      uploadFile: async () => {},
    } as unknown as SlackReporter;

    // Create components
    const runner = new SessionManager(config, mockReporter);
    const authorizer = new Authorizer(config);
    const router = new CommandRouter(config, mockReporter, runner, authorizer);

    // Simulate real Slack message event
    const now = Date.now();
    const mockSlackMessage = {
      channelId: 'C0ACQMYN1C7', // Real test channel from .env
      userId: 'U0ACSAH0AAZ',    // Real user from .env
      text: 'run: echo SLACK_INTEGRATION_TEST',
      threadTs: `${now / 1000}.000000`,
      ts: `${now / 1000}.000001`,
    };

    console.log('[TEST] Simulating Slack message:', mockSlackMessage.text);

    // Process the message (exact same flow as real bot)
    await router.handleMessage(mockSlackMessage);

    // Wait for session to complete
    console.log('[TEST] Waiting for session to complete...');
    await new Promise(r => setTimeout(r, 2000));

    // Find the session log file
    console.log('[TEST] Looking for session log...');
    const logsDir = resolve(process.cwd(), 'logs', 'sessions');
    const files = readdirSync(logsDir);
    const recentFiles = files.filter((f: string) => f.includes('slack_integration'));

    console.log('[TEST] Session files created:', recentFiles);

    // Check posted messages
    console.log('[TEST] Messages posted:', postedMessages.length);
    postedMessages.forEach((msg, i) => {
      console.log(`  [${i}] "${msg.text}"`);
    });

    // Verify flow executed
    assert.ok(postedMessages.length > 0, 'Should have posted messages');
    assert.ok(
      postedMessages.some(m => m.text.includes('Session started')),
      'Should have posted "Session started" message'
    );

    // Check audit log
    console.log('[TEST] Checking audit log...');
    const auditPath = resolve(process.cwd(), 'logs', 'audit.log');
    assert.ok(existsSync(auditPath), 'Audit log should exist');
    const auditContent = readFileSync(auditPath, 'utf8');
    const auditLines = auditContent.trim().split('\n');
    const lastEntry = JSON.parse(auditLines[auditLines.length - 1]);

    console.log('[TEST] Last audit entry:', lastEntry);
    assert.strictEqual(lastEntry.command, 'echo SLACK_INTEGRATION_TEST');
    assert.strictEqual(lastEntry.prefix, 'run');

    // Check session log
    const sessionId = lastEntry.sessionId;
    const sessionLogPath = resolve(logsDir, `${sessionId}.log`);

    console.log('[TEST] Checking session log:', sessionLogPath);
    assert.ok(existsSync(sessionLogPath), `Session log should exist: ${sessionLogPath}`);

    const logContent = readFileSync(sessionLogPath, 'utf8');
    console.log('[TEST] Session log content:');
    console.log(logContent);

    // Verify output was captured
    assert.ok(logContent.includes('Session started'), 'Should have start marker');
    assert.ok(logContent.includes('SLACK_INTEGRATION_TEST'),
      `Log should contain output. Got:\n${logContent}`);
    assert.ok(logContent.includes('exit code: 0'), 'Should have exit code');
    assert.ok(logContent.includes('Session ended'), 'Should have end marker');

    console.log('[TEST] ✅ FULL SLACK INTEGRATION TEST PASSED');
  });

});
