import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { SessionManager } from '../../src/cli/runner.js';
import type { AppConfig, CommandConfig } from '../../src/types.js';

/**
 * E2E test for session lifecycle:
 * - Session starts
 * - Output is captured
 * - Session ends with proper markers
 * - Log file contains start and end markers
 */

describe('Session Lifecycle E2E', () => {
  let manager: SessionManager;
  let mockReporter: any;
  let postedMessages: Array<{ channelId: string; text: string; threadTs?: string }>;
  let updatedMessages: Array<{ channelId: string; ts: string; text: string }>;

  const testConfig: AppConfig = {
    slackAppToken: 'test',
    slackBotToken: 'test',
    listenChannels: ['TEST_CHANNEL'],
    allowedUserIds: ['TEST_USER'],
    behavior: {
      sessionTimeoutMinutes: 30,
      outputFlushIntervalMs: 100,
      outputMaxCharsPerMessage: 3500,
    },
    envelope: {
      promptText: 'TEST_PROMPT',
      activationDelayMs: 100,
      unclosedTimeoutMs: 5000,
    },
    logging: {
      level: 'debug' as const,
      sessionRetentionDays: 30,
    },
  };

  beforeEach(() => {
    postedMessages = [];
    updatedMessages = [];

    mockReporter = {
      postMessage: async (channelId: string, text: string, threadTs?: string) => {
        postedMessages.push({ channelId, text, threadTs });
        return `ts_${Date.now()}`;
      },
      updateMessage: async (channelId: string, ts: string, text: string) => {
        updatedMessages.push({ channelId, ts, text });
      },
    };

    manager = new SessionManager(testConfig, mockReporter);
  });

  afterEach(() => {
    // Clean up any running sessions
    for (const session of manager.listSessions()) {
      manager.stop(session.id);
    }
  });

  it('should complete full lifecycle for one-shot bash command', async () => {
    const testCommand: CommandConfig = {
      prefix: 'run',
      binary: 'bash.exe',
      args: ['-c'],
      mode: 'one-shot',
      envelope: false,
      description: 'Test bash command',
    };

    const threadTs = 'test_thread_1';

    // Spawn the session
    await manager.spawn({
      channelId: 'TEST_CHANNEL',
      threadTs,
      command: 'echo "E2E_TEST_OUTPUT"',
      config: testCommand,
      cwd: process.cwd(),
    });

    // Wait for command to execute and exit
    await new Promise(r => setTimeout(r, 3000));

    // Verify session is no longer active (completed)
    const activeSessions = manager.listSessions();
    assert.strictEqual(
      activeSessions.length,
      0,
      'Session should have completed and been removed'
    );

    // Verify Slack messages were posted
    const startMessage = postedMessages.find(m => m.text.includes('Session started'));
    assert.ok(startMessage, 'Start message should be posted');
    assert.strictEqual(startMessage?.threadTs, threadTs, 'Start message should be in thread');

    const endMessage = postedMessages.find(m => m.text.includes('Session complete'));
    assert.ok(endMessage, 'Completion message should be posted');
    assert.strictEqual(endMessage?.threadTs, threadTs, 'End message should be in thread');

    // Verify log file
    const sessionId = startMessage!.text.match(/session_\w+/)?.[0];
    assert.ok(sessionId, 'Session ID should be in start message');

    const logPath = resolve(process.cwd(), 'logs', 'sessions', `${sessionId}.log`);
    assert.ok(existsSync(logPath), `Log file should exist at ${logPath}`);

    const logContent = readFileSync(logPath, 'utf-8');
    assert.ok(logContent.includes('=== Session started:'), 'Log should have start marker');
    assert.ok(logContent.includes('E2E_TEST_OUTPUT'), 'Log should have command output');
    assert.ok(logContent.includes('=== Session ended:'), 'Log should have end marker');
    assert.ok(logContent.includes('exit code: 0'), 'Log should have exit code');
  });

  it('should handle multiple concurrent sessions', async () => {
    const testCommand: CommandConfig = {
      prefix: 'run',
      binary: 'bash.exe',
      args: ['-c'],
      mode: 'one-shot',
      envelope: false,
      description: 'Test bash command',
    };

    // Spawn two sessions with different thread IDs
    await manager.spawn({
      channelId: 'TEST_CHANNEL',
      threadTs: 'thread_1',
      command: 'echo "SESSION_1" && sleep 1',
      config: testCommand,
    });

    await manager.spawn({
      channelId: 'TEST_CHANNEL',
      threadTs: 'thread_2',
      command: 'echo "SESSION_2" && sleep 1',
      config: testCommand,
    });

    // Both sessions should be active
    await new Promise(r => setTimeout(r, 500));
    let activeSessions = manager.listSessions();
    assert.strictEqual(activeSessions.length, 2, 'Both sessions should be active');

    // Wait for both to complete
    await new Promise(r => setTimeout(r, 3000));
    activeSessions = manager.listSessions();
    assert.strictEqual(activeSessions.length, 0, 'Both sessions should have completed');

    // Verify both completion messages were posted
    const completionMessages = postedMessages.filter(m => m.text.includes('Session complete'));
    assert.strictEqual(completionMessages.length, 2, 'Both sessions should post completion');
  });

  it('should handle command with non-zero exit code', async () => {
    const testCommand: CommandConfig = {
      prefix: 'run',
      binary: 'bash.exe',
      args: ['-c'],
      mode: 'one-shot',
      envelope: false,
      description: 'Test bash command',
    };

    await manager.spawn({
      channelId: 'TEST_CHANNEL',
      threadTs: 'test_thread_error',
      command: 'echo "ERROR_TEST" && exit 42',
      config: testCommand,
    });

    await new Promise(r => setTimeout(r, 2000));

    // Verify error message was posted
    const errorMessage = postedMessages.find(m => m.text.includes('exit code 42'));
    assert.ok(errorMessage, 'Error message should be posted with exit code');
    assert.ok(errorMessage!.text.includes('❌'), 'Error message should have error emoji');

    // Verify log file has error exit code
    const startMessage = postedMessages.find(m => m.text.includes('Session started'));
    const sessionId = startMessage!.text.match(/session_\w+/)?.[0];
    const logPath = resolve(process.cwd(), 'logs', 'sessions', `${sessionId}.log`);
    const logContent = readFileSync(logPath, 'utf-8');

    assert.ok(logContent.includes('exit code: 42'), 'Log should have exit code 42');
  });

  it('should create separate sessions for same thread', async () => {
    const testCommand: CommandConfig = {
      prefix: 'run',
      binary: 'bash.exe',
      args: ['-c'],
      mode: 'one-shot',
      envelope: false,
      description: 'Test bash command',
    };

    // First command in thread
    await manager.spawn({
      channelId: 'TEST_CHANNEL',
      threadTs: 'reused_thread',
      command: 'echo "FIRST"',
      config: testCommand,
    });

    await new Promise(r => setTimeout(r, 2000));

    // Second command in same thread (after first completes)
    await manager.spawn({
      channelId: 'TEST_CHANNEL',
      threadTs: 'reused_thread',
      command: 'echo "SECOND"',
      config: testCommand,
    });

    await new Promise(r => setTimeout(r, 2000));

    // Should have two separate start messages
    const startMessages = postedMessages.filter(m => m.text.includes('Session started'));
    assert.strictEqual(startMessages.length, 2, 'Two separate sessions should be created');

    // Should have two separate completion messages
    const completeMessages = postedMessages.filter(m => m.text.includes('Session complete'));
    assert.strictEqual(completeMessages.length, 2, 'Two separate sessions should complete');
  });
});
