import { createHash } from 'crypto';
import { type ProcessHandle } from './processHandle.js';
import { type SessionStatus, type CommandConfig } from '../types.js';
import { type OutputRouter } from '../streaming/router.js';

/** Full runtime state of a single CLI session */
export interface Session {
  /** Unique human-readable ID — also the log-file base name */
  id: string;
  /** Slack channel where messages are posted */
  channelId: string;
  /** Thread timestamp — primary key and reply target */
  threadTs: string;
  /** Message timestamp of the session start message (for updates) */
  messageTs?: string;
  /** Raw command text entered by the user */
  command: string;
  /** Resolved CLI command configuration */
  config: CommandConfig;
  /** Current lifecycle state */
  status: SessionStatus;
  /** Epoch ms at spawn time */
  startedAt: number;
  /** Exit code (populated on exit or timeout) */
  exitCode?: number;
  /** Live process handle (PTY for interactive, child_process for one-shot) */
  process: ProcessHandle;
  /** Two-track output router (log + Slack) */
  router: OutputRouter;
  /** Handle to the session-timeout timer (null if timeout disabled) */
  timeoutHandle: ReturnType<typeof setTimeout> | null;
}

/**
 * Generates a unique session ID from the current wall-clock time
 * plus a short random suffix.  Format: session_YYYYMMDD_HHmmss_xxxxxx
 */
export function generateSessionId(): string {
  const d   = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
              + `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand  = Math.random().toString(36).slice(2, 8);
  return `session_${stamp}_${rand}`;
}

// UUID v5 namespace for slack-wrapper (generated once, fixed forever)
const NAMESPACE_UUID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // DNS namespace

/**
 * Converts an arbitrary string to a deterministic UUID v5.
 * This allows us to map slack thread identifiers (e.g., "slack-Cxxx-ts")
 * to valid UUIDs required by tools like Claude Code.
 */
export function stringToUuid(input: string): string {
  const hash = createHash('sha1')
    .update(NAMESPACE_UUID.replace(/-/g, ''))
    .update(input)
    .digest('hex');

  // UUID v5 format: xxxxxxxx-xxxx-5xxx-[89ab]xxx-xxxxxxxxxxxx
  const parts = [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '5' + hash.substring(13, 16), // version 5
    ((parseInt(hash.substring(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') + hash.substring(18, 20), // variant
    hash.substring(20, 32),
  ];

  return parts.join('-');
}
