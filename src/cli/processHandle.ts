import { spawn as ptySpawn, type IPty } from 'node-pty';
import { spawn as cpSpawn, type ChildProcess } from 'node:child_process';
import { type SessionMode } from '../types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ProcessHandle');

/**
 * Unified handle for a running subprocess.
 * Abstracts over node-pty (interactive) and child_process (one-shot)
 * so that SessionManager can treat both the same way.
 */
export interface ProcessHandle {
  onData(cb: (data: string) => void): void;
  onExit(cb: (exitCode: number) => void): void;
  write(data: string): void;
  kill(): void;
}

/** Wraps a node-pty IPty for interactive sessions */
export class PtyHandle implements ProcessHandle {
  constructor(private readonly pty: IPty) {}

  onData(cb: (data: string) => void): void {
    this.pty.onData(cb);
  }

  onExit(cb: (exitCode: number) => void): void {
    this.pty.onExit(({ exitCode }) => cb(exitCode ?? 0));
  }

  write(data: string): void {
    this.pty.write(data);
  }

  kill(): void {
    this.pty.kill();
  }
}

/** Wraps a child_process ChildProcess for one-shot commands */
export class SpawnHandle implements ProcessHandle {
  constructor(private readonly child: ChildProcess) {}

  onData(cb: (data: string) => void): void {
    this.child.stdout?.on('data', (chunk: Buffer) => {
      logger.debug('SpawnHandle stdout: %d bytes', chunk.length);
      cb(chunk.toString());
    });
    this.child.stderr?.on('data', (chunk: Buffer) => {
      logger.debug('SpawnHandle stderr: %d bytes', chunk.length);
      cb(chunk.toString());
    });
  }

  onExit(cb: (exitCode: number) => void): void {
    this.child.on('close', (code) => cb(code ?? 1));
  }

  write(data: string): void {
    this.child.stdin?.write(data + '\n');
  }

  kill(): void {
    this.child.kill();
  }
}

/**
 * Spawns a subprocess appropriate for the given mode.
 *   one-shot   → child_process.spawn (piped stdio, reliable on Windows)
 *   interactive → node-pty            (real PTY, needed for REPLs)
 *
 * Returns a ProcessHandle once the child has successfully started.
 * Rejects if the binary cannot be found / executed.
 */
export async function spawnProcess(
  binary: string,
  args:   string[],
  options: { mode: SessionMode; cwd: string },
): Promise<ProcessHandle> {
  if (options.mode === 'one-shot') {
    return new Promise<SpawnHandle>((resolve, reject) => {
      const child = cpSpawn(binary, args, {
        cwd:   options.cwd,
        env:   {
          ...process.env,
          // Fix Python encoding issues on Windows for tools like Kimi
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.on('error', reject);
      child.on('spawn', () => {
        // Pipe dummy input for tools like Claude that require stdin
        // Must close stdin so Claude knows input is complete
        child.stdin?.write('\n');
        child.stdin?.end();
        resolve(new SpawnHandle(child));
      });
    });
  }

  // interactive — node-pty spawn is synchronous; throws on failure
  const pty = ptySpawn(binary, args, {
    name: 'xterm-256color',
    cols:  220,
    rows:  50,
    cwd:   options.cwd,
    env:   { ...process.env },
  });
  return new PtyHandle(pty);
}
