// Test Kimi CLI output capture via node-pty (interactive mode)
import { spawn as ptySpawn } from 'node-pty';
import { setLogLevel, createLogger } from '../../dist/utils/logger.js';

setLogLevel('debug');
const logger = createLogger('TEST-KIMI-PTY');

console.log('=== TESTING KIMI CLI VIA PTY ===\n');

// Find kimi binary location
const kimiBinary = process.platform === 'win32'
  ? 'C:\\Users\\MagnusOne\\.local\\bin\\kimi.exe'
  : '/home/.local/bin/kimi';

console.log('Binary:', kimiBinary);
console.log('Args: --print -p "Say hi in one word"');

const pty = ptySpawn(kimiBinary, ['--print', '-p', 'Say hi in one word'], {
  name: 'xterm-256color',
  cols: 220,
  rows: 50,
  cwd: process.cwd(),
  env: { ...process.env },
});

let outputBuffer = '';
let dataCount = 0;

pty.onData((data) => {
  dataCount++;
  outputBuffer += data;
  console.log(`[DATA #${dataCount}] ${data.length} bytes`);
});

pty.onExit(({ exitCode, signal }) => {
  console.log('\n=== PTY EXIT ===');
  console.log('Exit code:', exitCode);
  console.log('Signal:', signal);
  console.log('Total data events:', dataCount);
  console.log('Total output bytes:', outputBuffer.length);
  console.log('\n--- RAW OUTPUT (first 2000 chars) ---');
  console.log(outputBuffer.slice(0, 2000));

  if (dataCount > 0 && outputBuffer.length > 0) {
    console.log('\n✅ SUCCESS: PTY output captured');
  } else {
    console.log('\n❌ FAIL: No output captured');
  }
  process.exit(0);
});

setTimeout(() => {
  console.log('\n❌ TIMEOUT: Kimi did not complete within 60 seconds');
  pty.kill();
  process.exit(1);
}, 60000);
