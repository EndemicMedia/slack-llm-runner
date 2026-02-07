/**
 * Quick test for Kimi one-shot mode through ProcessHandle
 */
import { spawnProcess } from '../../src/cli/processHandle.js';

const KIMI_PATH = 'C:/Users/MagnusOne/.local/bin/kimi.exe';

async function testKimiOneshot() {
  console.log('Testing Kimi one-shot mode...\n');

  const prompt = `[SLACK WRAPPER]
You are in a Slack-connected environment. To send a message to Slack, wrap it in markers: <<<SLACK:done>>> and <<<END_SLACK>>>.
Always wrap your final response in these markers.

Task: Say hello and confirm you understand the envelope format.`;

  console.log('Prompt:', prompt.slice(0, 100) + '...\n');

  const handle = await spawnProcess(KIMI_PATH, ['--quiet', '-p', prompt], {
    mode: 'one-shot',
    cwd: process.cwd(),
  });

  let output = '';

  handle.onData((data: string) => {
    output += data;
    process.stdout.write(data);
  });

  const exitCode = await new Promise<number>((resolve) => {
    handle.onExit(resolve);
  });

  console.log('\n\n--- Test Results ---');
  console.log('Exit code:', exitCode);
  console.log('Output length:', output.length);
  console.log('Contains <<<SLACK:', output.includes('<<<SLACK'));
  console.log('Contains <<<END_SLACK:', output.includes('<<<END_SLACK'));
}

testKimiOneshot().catch(console.error);
