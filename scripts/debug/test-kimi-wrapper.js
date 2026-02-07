// Test Kimi CLI through the wrapper's ProcessHandle abstraction
import { spawnProcess } from '../../dist/cli/processHandle.js';
import { setLogLevel, createLogger } from '../../dist/utils/logger.js';

setLogLevel('debug');
const logger = createLogger('TEST-KIMI-WRAPPER');

console.log('=== TESTING KIMI VIA WRAPPER PROCESSHANDLE ===\n');

async function testKimiSession() {
  console.log('1. Spawning Kimi in interactive mode via node-pty...');

  // Spawn Kimi in interactive mode (like the wrapper would)
  // Note: node-pty on Windows needs full path
  const kimiBinary = 'C:\\Users\\MagnusOne\\.local\\bin\\kimi.exe';
  const handle = await spawnProcess(kimiBinary, [], {
    mode: 'interactive',
    cwd: process.cwd(),
  });

  console.log('2. Process spawned, attaching listeners IMMEDIATELY...');

  let outputBuffer = '';
  let dataCount = 0;
  let exitFired = false;

  // Attach onData listener immediately
  handle.onData((data) => {
    dataCount++;
    outputBuffer += data;
    const preview = data.slice(0, 100).replace(/\n/g, '\\n');
    console.log(`[DATA #${dataCount}] ${data.length} bytes: ${preview}...`);
  });

  // Attach onExit listener
  handle.onExit((code) => {
    exitFired = true;
    console.log(`\n[EXIT] Exit code: ${code}`);
    showResults();
  });

  // Wait a bit for startup output
  console.log('3. Waiting for Kimi startup...');
  await new Promise(r => setTimeout(r, 3000));

  // Send a simple prompt
  console.log('4. Sending input: "Say hello in exactly 2 words then exit"');
  handle.write('Say hello in exactly 2 words then exit\n');

  // Wait for response
  await new Promise(r => setTimeout(r, 10000));

  // If not exited, send /exit command
  if (!exitFired) {
    console.log('5. Sending /exit command...');
    handle.write('/exit\n');
    await new Promise(r => setTimeout(r, 2000));
  }

  // Force kill if still running
  if (!exitFired) {
    console.log('6. Force killing...');
    handle.kill();
  }

  function showResults() {
    console.log('\n=== RESULTS ===');
    console.log('Data events:', dataCount);
    console.log('Output bytes:', outputBuffer.length);
    console.log('Exit fired:', exitFired);
    console.log('\n--- OUTPUT SAMPLE (last 1500 chars) ---');
    console.log(outputBuffer.slice(-1500));

    if (dataCount > 0 && outputBuffer.length > 0) {
      console.log('\n✅ SUCCESS: Kimi output captured through wrapper');
    } else {
      console.log('\n❌ FAIL: No output captured');
    }
    process.exit(0);
  }

  // Timeout
  setTimeout(() => {
    if (!exitFired) {
      console.log('\n⏱️ TIMEOUT: Test exceeded 30 seconds');
      showResults();
    }
  }, 30000);
}

testKimiSession().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
