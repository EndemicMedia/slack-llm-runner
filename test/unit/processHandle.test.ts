/**
 * Unit tests for the one-shot spawn path (child_process via SpawnHandle).
 * These run locally — no Slack, no bot, no PTY.  They verify that the
 * exact mechanism the bot uses to execute `run:` commands works correctly.
 *
 *   npx tsx --test test/processHandle.test.ts
 */
import { describe, it }     from 'node:test';
import assert               from 'node:assert';
import { spawn }            from 'node:child_process';
import { SpawnHandle, spawnProcess } from '../../src/cli/processHandle.js';

// `bash.exe` is Git for Windows' name on PATH (matching commands.yaml's
// win32 shell config); on Linux/macOS the same shell is just `bash`. These
// tests exercise the spawn mechanism, not a specific shell, so they use
// whichever name resolves on the current platform.
const bashBinary = process.platform === 'win32' ? 'bash.exe' : 'bash';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Collect all output + exit code from a SpawnHandle, returns a promise */
function collect(handle: SpawnHandle): Promise<{ output: string; code: number }> {
  return new Promise((resolve) => {
    let output = '';
    handle.onData((data) => { output += data; });
    handle.onExit((code)  => resolve({ output, code }));
  });
}

// ── SpawnHandle – direct wrapper tests ──────────────────────────────────────

describe('SpawnHandle – basic output capture', () => {

  it('captures stdout from a simple echo', async () => {
    const child  = spawn(bashBinary, ['-c', 'echo hello world'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const handle = new SpawnHandle(child);
    const { output, code } = await collect(handle);

    assert.strictEqual(code, 0);
    assert.ok(output.includes('hello world'), `stdout missing "hello world" — got: ${JSON.stringify(output)}`);
  });

  it('captures multi-line stdout', async () => {
    const child  = spawn(bashBinary, ['-c', 'echo line1; echo line2; echo line3'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const handle = new SpawnHandle(child);
    const { output, code } = await collect(handle);

    assert.strictEqual(code, 0);
    assert.ok(output.includes('line1'), `Missing line1 in: ${JSON.stringify(output)}`);
    assert.ok(output.includes('line2'), `Missing line2 in: ${JSON.stringify(output)}`);
    assert.ok(output.includes('line3'), `Missing line3 in: ${JSON.stringify(output)}`);
  });

  it('captures stderr', async () => {
    const child  = spawn(bashBinary, ['-c', 'echo err-msg 1>&2'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const handle = new SpawnHandle(child);
    const { output } = await collect(handle);

    assert.ok(output.includes('err-msg'), `stderr missing "err-msg" — got: ${JSON.stringify(output)}`);
  });

  it('captures mixed stdout + stderr', async () => {
    // out1 → stdout, out2 → stderr, out3 → stdout
    const child  = spawn(bashBinary, ['-c', 'echo out1; echo out2 1>&2; echo out3'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const handle = new SpawnHandle(child);
    const { output } = await collect(handle);

    assert.ok(output.includes('out1'), `Missing out1 in: ${JSON.stringify(output)}`);
    assert.ok(output.includes('out2'), `Missing out2 in: ${JSON.stringify(output)}`);
    assert.ok(output.includes('out3'), `Missing out3 in: ${JSON.stringify(output)}`);
  });
});

describe('SpawnHandle – exit codes', () => {

  it('reports exit code 0 on success', async () => {
    const child  = spawn(bashBinary, ['-c', 'exit 0'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const handle = new SpawnHandle(child);
    const { code } = await collect(handle);
    assert.strictEqual(code, 0);
  });

  it('reports non-zero exit code', async () => {
    const child  = spawn(bashBinary, ['-c', 'exit 42'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const handle = new SpawnHandle(child);
    const { code } = await collect(handle);
    assert.strictEqual(code, 42);
  });

  it('reports exit code 1 from a failing command', async () => {
    const child  = spawn(bashBinary, ['-c', 'nonexistent_cmd_xyz123'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const handle = new SpawnHandle(child);
    const { code } = await collect(handle);
    assert.notStrictEqual(code, 0);
  });
});

describe('SpawnHandle – kill', () => {

  it('kill() terminates a long-running process promptly', async () => {
    const start = Date.now();
    // A shell running `sleep`/`timeout` as a subcommand forks a child of its
    // own; on Windows, killing the wrapping bash.exe doesn't reliably reach
    // that grandchild, so the process lingers for the full duration. Use
    // Windows' native single-process `timeout` (no subshell fork) there, and
    // bash's `sleep` (which behaves correctly under a real POSIX shell) on
    // Linux/macOS — this test is about kill() promptness, not about bash.
    const [killBinary, killArgs] = process.platform === 'win32'
      ? ['cmd', ['/c', 'timeout /t 30 /nobreak >nul']]
      : [bashBinary, ['-c', 'sleep 30']];
    const child  = spawn(killBinary, killArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    const handle = new SpawnHandle(child);

    setTimeout(() => handle.kill(), 200);

    const { code } = await collect(handle);
    const elapsed  = Date.now() - start;

    assert.ok(elapsed < 3000, `Process took ${elapsed} ms to exit after kill (expected < 3 s)`);
    assert.notStrictEqual(code, 0, 'Killed process should not exit with code 0');
  });
});

// ── spawnProcess factory – the actual entry point used by the runner ─────────

describe('spawnProcess – one-shot factory', () => {

  it('spawns and captures output via the factory', async () => {
    const handle = await spawnProcess(bashBinary, ['-c', 'echo factory-ok'], {
      mode: 'one-shot',
      cwd:  process.cwd(),
    });
    const { output, code } = await collect(handle as SpawnHandle);

    assert.strictEqual(code, 0);
    assert.ok(output.includes('factory-ok'), `Missing "factory-ok" in: ${JSON.stringify(output)}`);
  });

  it('rejects when binary does not exist', async () => {
    await assert.rejects(
      () => spawnProcess('this_binary_does_not_exist_xyz', [], { mode: 'one-shot', cwd: process.cwd() }),
      /ENOENT/,
    );
  });
});

// ── bash.exe – the shell configured in commands.yaml ────────────────────────

describe(`spawnProcess – ${bashBinary} (commands.yaml shell)`, () => {

  it(`runs echo via ${bashBinary} -c`, async () => {
    const handle = await spawnProcess(bashBinary, ['-c', 'echo bash-works'], {
      mode: 'one-shot',
      cwd:  process.cwd(),
    });
    const { output, code } = await collect(handle as SpawnHandle);

    assert.strictEqual(code, 0);
    assert.ok(output.includes('bash-works'), `Missing "bash-works" in: ${JSON.stringify(output)}`);
  });

  it('captures exit code from bash -c "exit N"', async () => {
    const handle = await spawnProcess(bashBinary, ['-c', 'exit 7'], {
      mode: 'one-shot',
      cwd:  process.cwd(),
    });
    const { code } = await collect(handle as SpawnHandle);
    assert.strictEqual(code, 7);
  });

  it('captures stderr from bash', async () => {
    const handle = await spawnProcess(bashBinary, ['-c', 'echo bash-err >&2'], {
      mode: 'one-shot',
      cwd:  process.cwd(),
    });
    const { output } = await collect(handle as SpawnHandle);
    assert.ok(output.includes('bash-err'), `Missing "bash-err" in: ${JSON.stringify(output)}`);
  });

  it('runs a realistic multi-step command', async () => {
    const handle = await spawnProcess(bashBinary, ['-c', 'echo step1 && echo step2 && echo step3'], {
      mode: 'one-shot',
      cwd:  process.cwd(),
    });
    const { output, code } = await collect(handle as SpawnHandle);

    assert.strictEqual(code, 0);
    assert.ok(output.includes('step1'), `Missing step1`);
    assert.ok(output.includes('step2'), `Missing step2`);
    assert.ok(output.includes('step3'), `Missing step3`);
  });
});
