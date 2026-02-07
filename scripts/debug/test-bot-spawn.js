// Test bot's spawn code path
import { spawnProcess } from '../../dist/cli/processHandle.js';
import { setLogLevel, createLogger } from '../../dist/utils/logger.js';

setLogLevel('debug');
const logger = createLogger('TEST');

logger.debug('=== TESTING BOT SPAWN MECHANISM ===');

const handle = await spawnProcess('bash.exe', ['-c', 'echo BOT_SPAWN_TEST'], {
  mode: 'one-shot',
  cwd: process.cwd(),
});

logger.debug('SpawnProcess returned, attaching listeners...');

let dataCount = 0;
let exitFired = false;

handle.onData((data) => {
  dataCount++;
  logger.debug('✓ onData fired #%d: %d bytes', dataCount, data.length);
  console.log('[RAW onData]', JSON.stringify(data));
});

handle.onExit((exitCode) => {
  exitFired = true;
  logger.debug('✓ onExit fired with code: %d', exitCode);

  setTimeout(() => {
    if (dataCount > 0) {
      console.log('\n✅ SUCCESS: onData fired', dataCount, 'time(s)');
    } else {
      console.log('\n❌ FAIL: onData never fired!');
    }
    process.exit(0);
  }, 500);
});

logger.debug('Listeners attached, waiting for events...');

setTimeout(() => {
  if (!exitFired) {
    console.log('\n❌ TIMEOUT: Process did not exit within 5 seconds');
    process.exit(1);
  }
}, 5000);
