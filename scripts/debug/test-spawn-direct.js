// Direct spawn test - bypasses all Slack/bot logic
import { spawn } from 'node:child_process';

console.log('=== DIRECT SPAWN TEST ===');
console.log('Spawning: bash.exe -c "echo DIRECT_TEST_OUTPUT"');

const child = spawn('bash.exe', ['-c', 'echo DIRECT_TEST_OUTPUT'], {
  cwd: process.cwd(),
  env: { ...process.env },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdoutData = '';
let stderrData = '';

child.stdout.on('data', (chunk) => {
  console.log('✓ STDOUT DATA EVENT:', chunk.length, 'bytes');
  stdoutData += chunk.toString();
  console.log('  Content:', JSON.stringify(chunk.toString()));
});

child.stderr.on('data', (chunk) => {
  console.log('✓ STDERR DATA EVENT:', chunk.length, 'bytes');
  stderrData += chunk.toString();
  console.log('  Content:', JSON.stringify(chunk.toString()));
});

child.on('close', (code) => {
  console.log('✓ PROCESS CLOSED with code:', code);
  console.log('  Total stdout:', stdoutData.length, 'bytes');
  console.log('  Total stderr:', stderrData.length, 'bytes');
  console.log('  Stdout content:', JSON.stringify(stdoutData));
  console.log('  Stderr content:', JSON.stringify(stderrData));

  if (stdoutData.includes('DIRECT_TEST_OUTPUT')) {
    console.log('\n✅ SUCCESS: Output was captured!');
  } else {
    console.log('\n❌ FAIL: Expected output not found');
  }

  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error('✗ SPAWN ERROR:', err);
  process.exit(1);
});

console.log('Waiting for process to complete...');
