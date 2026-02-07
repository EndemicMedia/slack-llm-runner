// Test full session lifecycle including exit handling
import { spawnProcess } from '../../dist/cli/processHandle.js';
import { setLogLevel, createLogger } from '../../dist/utils/logger.js';

setLogLevel('debug');
const logger = createLogger('TEST-LIFECYCLE');

console.log('=== TESTING FULL SESSION LIFECYCLE ===\n');

// Simulate what runner.ts does
async function testSessionLifecycle() {
  console.log('1. Spawning process...');

  const handle = await spawnProcess('bash.exe', ['-c', 'echo LIFECYCLE_TEST && sleep 1 && echo DONE'], {
    mode: 'one-shot',
    cwd: process.cwd(),
  });

  console.log('2. Process spawned, attaching listeners IMMEDIATELY...');

  let dataReceived = [];
  let exitFired = false;
  let exitCode = null;

  // Attach onData listener immediately (like our fix)
  handle.onData((data) => {
    const timestamp = new Date().toISOString();
    console.log(`3. [${timestamp}] onData fired: ${data.length} bytes`);
    console.log(`   Content: ${JSON.stringify(data)}`);
    dataReceived.push(data);
  });

  // Attach onExit listener immediately
  handle.onExit((code) => {
    const timestamp = new Date().toISOString();
    console.log(`4. [${timestamp}] onExit fired with code: ${code}`);
    exitFired = true;
    exitCode = code;

    // Simulate finalise()
    console.log('5. Simulating finalise()...');
    console.log('   - Would call router.finish()');
    console.log('   - Would call logWriter.close()');
    console.log('   - Would post completion message to Slack');
    console.log('   - Would remove session from map');

    setTimeout(() => {
      console.log('\n=== LIFECYCLE TEST RESULTS ===');
      console.log('Data events received:', dataReceived.length);
      console.log('Exit event fired:', exitFired);
      console.log('Exit code:', exitCode);
      console.log('Total output bytes:', dataReceived.reduce((sum, d) => sum + d.length, 0));

      if (exitFired && dataReceived.length > 0) {
        console.log('\n✅ SUCCESS: Full lifecycle works correctly');
      } else {
        console.log('\n❌ FAIL: Lifecycle incomplete');
        if (!exitFired) console.log('   - onExit never fired');
        if (dataReceived.length === 0) console.log('   - No data received');
      }
      process.exit(0);
    }, 500);
  });

  console.log('Listeners attached, waiting for process...\n');
}

testSessionLifecycle().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

// Fallback timeout
setTimeout(() => {
  console.log('\n❌ TIMEOUT: Process did not complete within 10 seconds');
  process.exit(1);
}, 10000);
