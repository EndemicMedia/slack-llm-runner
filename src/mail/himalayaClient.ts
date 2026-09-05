/**
 * Thin, low-level wrapper around the `himalaya` CLI binary (Rust mail client, v2.x).
 *
 * This module is intentionally "dumb": it knows how to invoke himalaya with
 * arbitrary args and parse `--json` output. It does NOT know which himalaya
 * subcommands are safe to call (read vs. write) — that trust boundary is
 * enforced by higher layers (`mailctl.ts` for reads, `executor.ts` for
 * writes), which decide which args to pass in. Keeping this file agnostic
 * to that boundary means it must never grow convenience helpers that make
 * calling a write subcommand (e.g. `message delete`, `message move`,
 * `flag add`) any easier or more tempting than calling a read one.
 *
 * Security note: always uses `execFile` (never `exec`/shell string
 * interpolation) so argv is passed directly to the OS without a shell
 * parsing it — this is the injection-safety guarantee the rest of the
 * mail-triage feature depends on.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('HimalayaClient');

const execFileAsync = promisify(execFile);

/** Default timeout for a himalaya invocation, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 15000;

/** Options accepted by {@link runHimalaya}. */
export interface RunHimalayaOptions {
  /** himalaya account name, passed as `--account <name>` when set. */
  account?: string;
  /** Kill the child process if it runs longer than this, in ms. Default 15000. */
  timeoutMs?: number;
}

/**
 * Thrown when a himalaya invocation fails — either the process exited
 * non-zero, or its stdout could not be parsed as JSON.
 */
export class HimalayaError extends Error {
  /** The argv passed to himalaya (excluding the binary name itself). */
  readonly args: string[];
  /** Process exit code, or null if the process was killed (e.g. timeout). */
  readonly exitCode: number | null;
  /** Captured stderr output, if any. */
  readonly stderr: string;

  constructor(message: string, opts: { args: string[]; exitCode: number | null; stderr: string; cause?: unknown }) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'HimalayaError';
    this.args = opts.args;
    this.exitCode = opts.exitCode;
    this.stderr = opts.stderr;
  }
}

/**
 * Resolves the directory himalaya is expected to read its config from, for
 * documentation and health-check/error-message purposes only. This is never
 * passed to himalaya as `--config` — himalaya already performs this same
 * resolution itself by default:
 *   - Unix: `$XDG_CONFIG_HOME/himalaya`, falling back to `~/.config/himalaya`
 *     (or `~/.himalayarc`)
 *   - Windows: `%APPDATA%\himalaya`
 */
export function resolveConfigDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'himalaya');
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(xdgConfigHome, 'himalaya');
}

/**
 * Runs the `himalaya` CLI binary with the given args and returns the parsed
 * JSON result. Always appends `--json`, and prepends `--account <name>` when
 * `opts.account` is provided.
 *
 * This function is deliberately generic — it runs whatever args it is given.
 * Callers (mailctl for reads, executor for writes) are responsible for
 * deciding which himalaya subcommands are appropriate to invoke.
 */
export async function runHimalaya(args: string[], opts?: RunHimalayaOptions): Promise<unknown> {
  const argv = [...(opts?.account ? ['--account', opts.account] : []), ...args, '--json'];
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  logger.debug(`running: himalaya ${argv.join(' ')}`);

  let stdout: string;
  let stderr: string;
  try {
    const result = await execFileAsync('himalaya', argv, { timeout: timeoutMs });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number | null; killed?: boolean; message?: string };
    const stderrOut = execErr.stderr ?? '';
    logger.error(`himalaya exited with error (code=${execErr.code ?? 'null'}): ${execErr.message ?? String(err)}`);
    throw new HimalayaError(
      `himalaya command failed${execErr.killed ? ' (timed out or was killed)' : ''}: ${execErr.message ?? String(err)}`,
      { args: argv, exitCode: execErr.code ?? null, stderr: stderrOut, cause: err },
    );
  }

  if (stderr && stderr.trim().length > 0) {
    logger.warn(`himalaya wrote to stderr: ${stderr.trim()}`);
  }

  try {
    return JSON.parse(stdout);
  } catch (err) {
    logger.error(`failed to parse himalaya stdout as JSON: ${String(err)}`);
    throw new HimalayaError('failed to parse himalaya output as JSON', {
      args: argv,
      exitCode: 0,
      stderr,
      cause: err,
    });
  }
}
