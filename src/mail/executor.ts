/**
 * `mail-executor` — the deterministic side of the mail-triage feature.
 *
 * SECURITY BOUNDARY. This is the only file in the feature that performs a real
 * himalaya *write*, and it is the counterpart to `mailctl.ts`:
 *
 *   Claude never picks an email recipient, and never executes a write.
 *
 * How that is enforced here, structurally rather than by prose:
 *
 *  1. The ONLY input this process accepts is an `action_id` — an opaque UUID
 *     that must already exist as a row in the local `proposed_actions` table.
 *     Nothing else Claude produced reaches this file.
 *  2. The row is executed only when its `status` is exactly `'approved'`, a
 *     value only a human decision (`markDecided`) can write. `'pending'` is
 *     treated as "not yet decided" and refused; so is every other status.
 *  3. Every himalaya argument that identifies *what* is acted on — envelope id,
 *     folder, account — is read from the stored `mail_envelopes` row, which is
 *     populated only by `mailctl`'s read subcommands straight from the mail
 *     server. `params_json` supplies only kind-specific detail (target folder,
 *     flag name, reply body) and structurally cannot supply a recipient:
 *     `ActionParams`' `reply` variant has exactly one field, `body`.
 *  4. `message reply` is invoked WITHOUT `--to`/`--cc`/`--bcc`. himalaya
 *     derives the recipient itself from the stored source message given its id
 *     and folder — which is exactly the "recipient derived from the message,
 *     not from the model" property this design exists to provide. No reply-all.
 *  5. Execution is claimed atomically (`store.claimForExecution`) before any
 *     himalaya call, closing the cross-process double-click race.
 *
 * stdout is reserved for the machine-readable JSON result (the Slack handler
 * parses it). All errors and diagnostics go to stderr, and the process exits
 * non-zero on failure.
 */
import path from 'node:path';
import { runHimalaya as realRunHimalaya } from './himalayaClient.js';
import { MailStore } from './threadStore.js';
import type { ActionKind, ActionParams, MailEnvelope, ProposedAction } from './types.js';

/** Fallback SQLite path when `MAILCTL_DB_PATH` is unset. Matches `mailctl.ts`. */
export const DEFAULT_DB_PATH = 'data/mail.db';

/** Minimal store surface the executor needs — lets tests inject a temp store. */
export interface ExecutorStore {
  getProposedAction(actionId: string): ProposedAction | undefined;
  getEnvelopeByMessageId(messageId: string): MailEnvelope | undefined;
  claimForExecution(actionId: string): boolean;
  markExecuted(actionId: string, status: 'executed' | 'failed', error?: string): void;
}

/** Injectable dependencies, so `executeAction` is testable without a mailbox. */
export interface Deps {
  runHimalaya: (args: string[], opts?: { account?: string; timeoutMs?: number }) => Promise<unknown>;
  store: ExecutorStore;
}

/**
 * Outcome of one `executeAction` call. Printed as JSON on stdout; the Slack
 * handler uses it to post a confirmation into the thread — addressing that
 * message with `slackChannelId`/`slackThreadTs` read off the stored row, never
 * re-derived from anything the model produced.
 */
export interface ExecutionResult {
  actionId: string;
  kind: ActionKind | null;
  /** `true` only when a himalaya write ran and succeeded. */
  success: boolean;
  /**
   * - `executed`  — the himalaya write ran and succeeded.
   * - `failed`    — the himalaya write (or param parsing) failed; row marked `failed`.
   * - `skipped`   — deliberate no-op: not approved, or lost the execution claim.
   */
  outcome: 'executed' | 'failed' | 'skipped';
  /** Human-readable explanation; always set for `failed`/`skipped`. */
  reason?: string;
  /** Slack addressing copied off the stored row, for the caller's confirmation post. */
  slackChannelId?: string;
  slackThreadTs?: string;
  slackMessageTs?: string | null;
  /** The exact himalaya argv that was run, for audit logging. */
  himalayaArgs?: string[];
  account?: string;
}

/** Raised for failures that should exit non-zero without a stack trace. */
export class ExecutorError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'ExecutorError';
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// params
// ---------------------------------------------------------------------------

const VALID_FLAGS = new Set(['seen', 'answered', 'flagged', 'draft']);
const VALID_OPS = new Set(['add', 'remove']);

/**
 * Parses `params_json` into `ActionParams`, re-validating everything.
 *
 * The row was written by `mailctl propose`, which already validated — but this
 * is a separate process reading a mutable local file, so it re-checks rather
 * than trusting. Note there is no branch here that can produce a recipient:
 * no variant of `ActionParams` has a `to`/`cc`/`bcc` field to populate.
 */
export function parseActionParams(kind: ActionKind, paramsJson: string): ActionParams {
  let raw: unknown;
  try {
    raw = JSON.parse(paramsJson);
  } catch (err) {
    throw new ExecutorError(`params_json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== 'object') {
    throw new ExecutorError('params_json is not an object');
  }
  const o = raw as Record<string, unknown>;
  if (o.kind !== undefined && o.kind !== kind) {
    throw new ExecutorError(`params_json kind "${String(o.kind)}" does not match action kind "${kind}"`);
  }

  switch (kind) {
    case 'archive':
      return { kind: 'archive' };
    case 'delete':
      return { kind: 'delete' };
    case 'move': {
      const toFolder = o.toFolder;
      if (typeof toFolder !== 'string' || toFolder.length === 0) {
        throw new ExecutorError('move action is missing a "toFolder" param');
      }
      return { kind: 'move', toFolder };
    }
    case 'flag': {
      const flag = o.flag;
      const op = o.op;
      if (typeof flag !== 'string' || !VALID_FLAGS.has(flag)) {
        throw new ExecutorError(`invalid flag "${String(flag)}"`);
      }
      if (typeof op !== 'string' || !VALID_OPS.has(op)) {
        throw new ExecutorError(`invalid flag op "${String(op)}"`);
      }
      return { kind: 'flag', flag: flag as 'seen' | 'answered' | 'flagged' | 'draft', op: op as 'add' | 'remove' };
    }
    case 'reply': {
      const body = o.body;
      if (typeof body !== 'string') {
        throw new ExecutorError('reply action is missing a "body" param');
      }
      return { kind: 'reply', body };
    }
    default:
      throw new ExecutorError(`unsupported action kind "${String(kind)}"`);
  }
}

// ---------------------------------------------------------------------------
// argv construction
// ---------------------------------------------------------------------------

/**
 * Builds the himalaya argv for one action.
 *
 * `envelope` is the single source of truth for *which* message is touched
 * (`id`, `folder`) and on which account. `params` contributes only the
 * kind-specific detail. Exported so tests can assert the exact shapes.
 */
export function buildHimalayaArgs(params: ActionParams, envelope: MailEnvelope): string[] {
  const id = String(envelope.id);
  switch (params.kind) {
    case 'archive':
      // "archive" is a himalaya mailbox alias (`mailbox.alias.archive`).
      return ['message', 'move', id, '--from', envelope.folder, '--to', 'archive'];
    case 'move':
      return ['message', 'move', id, '--from', envelope.folder, '--to', params.toFolder];
    case 'flag':
      return ['flag', params.op, '--flag', params.flag, id, '--folder', envelope.folder];
    case 'reply':
      // No --to/--cc/--bcc, and no --all: himalaya derives the single recipient
      // from the stored source message itself. Reply-to-sender only in v1.
      return ['message', 'reply', id, '--folder', envelope.folder, '--body', params.body, '--send'];
    case 'delete':
      // Trash-only: himalaya's `message delete` moves to trash from a
      // non-trash folder. There is no purge action in v1.
      return ['message', 'delete', id, '--folder', envelope.folder];
  }
}

// ---------------------------------------------------------------------------
// core
// ---------------------------------------------------------------------------

/** Testable core. Never throws for expected conditions — returns a result. */
export async function executeAction(actionId: string, deps: Deps): Promise<ExecutionResult> {
  const action = deps.store.getProposedAction(actionId);
  if (!action) {
    throw new ExecutorError(`no proposed action with action_id "${actionId}"`);
  }

  const slack = {
    slackChannelId: action.slackChannelId,
    slackThreadTs: action.slackThreadTs,
    slackMessageTs: action.slackMessageTs,
  };

  // 1. Only an explicit human approval may lead to execution. 'pending' means
  //    "not yet decided"; 'executed'/'failed'/'rejected'/'expired' mean it is
  //    already settled. Either way: silent no-op, no himalaya call, and the
  //    row's status is left exactly as it is.
  if (action.status !== 'approved') {
    return {
      actionId,
      kind: action.kind,
      success: false,
      outcome: 'skipped',
      reason: `action status is "${action.status}", not "approved" — refusing to execute`,
      ...slack,
    };
  }

  // 2. Parse the stored params. A malformed row is a hard failure, not a no-op.
  let params: ActionParams;
  try {
    params = parseActionParams(action.kind, action.paramsJson);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.store.markExecuted(actionId, 'failed', message);
    return { actionId, kind: action.kind, success: false, outcome: 'failed', reason: message, ...slack };
  }

  // 3. Resolve the source envelope. This — not params_json — decides who and
  //    what is acted on.
  const envelope = deps.store.getEnvelopeByMessageId(action.sourceMessageId);
  if (!envelope) {
    const message = 'source envelope not found in local store';
    deps.store.markExecuted(actionId, 'failed', message);
    return { actionId, kind: action.kind, success: false, outcome: 'failed', reason: message, ...slack };
  }

  // 4. Claim execution atomically, across processes, before touching the mail
  //    server. Losing the claim means another invocation is already executing
  //    this exact action — a silent no-op, same as an unapproved status.
  if (!deps.store.claimForExecution(actionId)) {
    return {
      actionId,
      kind: action.kind,
      success: false,
      outcome: 'skipped',
      reason: 'action was already claimed for execution by another invocation',
      ...slack,
    };
  }

  const args = buildHimalayaArgs(params, envelope);

  try {
    await deps.runHimalaya(args, { account: envelope.account });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.store.markExecuted(actionId, 'failed', message);
    return {
      actionId,
      kind: action.kind,
      success: false,
      outcome: 'failed',
      reason: message,
      himalayaArgs: args,
      account: envelope.account,
      ...slack,
    };
  }

  deps.store.markExecuted(actionId, 'executed');
  return {
    actionId,
    kind: action.kind,
    success: true,
    outcome: 'executed',
    himalayaArgs: args,
    account: envelope.account,
    ...slack,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function resolveDbPath(): string {
  return process.env.MAILCTL_DB_PATH ?? DEFAULT_DB_PATH;
}

export type Subcommand = 'execute';

export async function dispatch(argv: string[], deps: Deps): Promise<ExecutionResult> {
  const [sub, ...rest] = argv;
  if (sub !== 'execute') {
    throw new ExecutorError('usage: mail-executor execute <action-id>');
  }
  const actionId = rest[0];
  if (!actionId) throw new ExecutorError('execute requires an action-id');
  if (rest.length > 1) {
    throw new ExecutorError(`execute takes exactly one action-id (got ${rest.length} arguments)`);
  }
  return executeAction(actionId, deps);
}

/** Real entry point. Never throws — prints to stderr and returns an exit code. */
export async function main(argv: string[]): Promise<number> {
  let store: MailStore | undefined;
  try {
    store = new MailStore(resolveDbPath());
    const result = await dispatch(argv, { runHimalaya: realRunHimalaya, store });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    // A deliberate no-op is not an error; a failed write is.
    return result.outcome === 'failed' ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`mail-executor: ${message}\n`);
    return err instanceof ExecutorError ? err.exitCode : 1;
  } finally {
    store?.close();
  }
}

const entry = process.argv[1] ? path.basename(process.argv[1]) : '';
const isDirectRun = entry === 'executor.js' || entry === 'executor' || entry === 'executor.ts';
if (isDirectRun) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`mail-executor: unexpected error: ${String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
