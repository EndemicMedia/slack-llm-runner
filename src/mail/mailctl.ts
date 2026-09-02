/**
 * `mailctl` — the restricted mail CLI that Claude is allowed to run.
 *
 * SECURITY BOUNDARY. This file *is* the enforcement surface for the core
 * invariant of the mail-triage feature:
 *
 *   Claude never picks an email recipient, and never executes a write.
 *
 * How that is enforced here, structurally rather than by prose:
 *
 *  1. The only himalaya subcommands referenced anywhere in this file are
 *     read-only: `envelope list`, `envelope search`, `message read`. There is
 *     no code path in this file that can reach a himalaya write subcommand,
 *     so no `--allowedTools` misconfiguration can turn a mailctl invocation
 *     into a mail-server mutation.
 *  2. `message read` is invoked WITHOUT `--seen`, so even reading has no
 *     server-side side effect.
 *  3. `propose` — the only write-shaped subcommand — never calls
 *     `runHimalaya` and never touches the network. It writes a single row to
 *     the local SQLite queue for a human to approve later.
 *  4. `propose` has NO `--to` / `--recipient` / `--cc` / `--bcc` flag, and its
 *     parser rejects unknown flags outright. The recipient for a `reply` is
 *     derived later, by the deterministic executor, from the stored
 *     envelope's `from_addr` — never from anything passed in here.
 *
 * stdout is reserved for machine-readable JSON (callers parse it). All errors
 * and diagnostics go to stderr, and the process exits non-zero.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { runHimalaya as realRunHimalaya } from './himalayaClient.js';
import { MailStore } from './threadStore.js';
import type { ActionKind, ActionParams, MailEnvelope } from './types.js';

/** Fallback himalaya account when neither `--account` nor the env var is set. */
export const DEFAULT_ACCOUNT = 'default';
/** Fallback SQLite path when `MAILCTL_DB_PATH` is unset. */
export const DEFAULT_DB_PATH = 'data/mail.db';

/** The five action kinds this CLI may propose. `send` is deliberately absent. */
export const VALID_KINDS: readonly ActionKind[] = ['archive', 'move', 'flag', 'reply', 'delete'];
const VALID_FLAGS = ['seen', 'answered', 'flagged', 'draft'] as const;
const VALID_OPS = ['add', 'remove'] as const;

/** Minimal store surface mailctl needs — lets tests inject a temp store. */
export interface MailctlStore {
  upsertEnvelope(env: MailEnvelope): void;
  getEnvelopeByMessageId(messageId: string): MailEnvelope | undefined;
  createProposedAction(a: {
    actionId: string;
    idempotencyKey: string;
    kind: ActionKind;
    sourceMessageId: string;
    paramsJson: string;
    slackChannelId: string;
    slackThreadTs: string;
    slackMessageTs: string | null;
  }): string;
  getProposedActionByIdempotencyKey?(key: string): { actionId: string } | undefined;
}

/** Injectable dependencies, so handlers are unit-testable without a real mailbox. */
export interface Deps {
  runHimalaya: (args: string[], opts?: { account?: string; timeoutMs?: number }) => Promise<unknown>;
  store: MailctlStore;
  /** `YYYY-MM-DD` used in the idempotency key. Injectable for deterministic tests. */
  today?: () => string;
}

/** Raised for user-facing failures; `main` prints the message and exits non-zero. */
export class MailctlError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'MailctlError';
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string>;
}

/**
 * Parses `--key value` pairs plus positionals. Unknown flags are rejected by
 * the caller via `allowedFlags` — this is what guarantees that a stray
 * `--to someone@example.com` can never be silently accepted and carried into
 * a proposed action.
 */
export function parseArgs(argv: string[], allowedFlags: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  const allowed = new Set(allowedFlags);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      if (!allowed.has(name)) {
        throw new MailctlError(`unknown option --${name}`);
      }
      let value: string | undefined;
      if (eq !== -1) {
        value = token.slice(eq + 1);
      } else {
        value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new MailctlError(`option --${name} requires a value`);
        }
        i++;
      }
      flags[name] = value;
    } else {
      positionals.push(token);
    }
  }

  return { positionals, flags };
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const v = flags[name];
  if (v === undefined || v === '') throw new MailctlError(`--${name} is required`);
  return v;
}

function resolveAccount(flags: Record<string, string>): string {
  return flags.account ?? process.env.MAILCTL_ACCOUNT ?? DEFAULT_ACCOUNT;
}

function resolveFolder(flags: Record<string, string>): string {
  return flags.folder ?? 'inbox';
}

// ---------------------------------------------------------------------------
// himalaya envelope -> MailEnvelope mapping
// ---------------------------------------------------------------------------

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Renders a himalaya address (string, or `{name?, addr}`) as a plain address string. */
function addrToString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const addr = asString(o.addr) ?? asString(o.address) ?? asString(o.email);
    if (addr) return addr;
    const name = asString(o.name);
    if (name) return name;
  }
  return '';
}

function addrListToStrings(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(addrToString).filter((s) => s.length > 0);
  const one = addrToString(v);
  return one ? [one] : [];
}

/**
 * Maps one himalaya envelope JSON object (kebab-case fields) into the
 * camelCase `MailEnvelope` shape used by the store.
 */
export function mapEnvelope(raw: unknown, account: string, folder: string): MailEnvelope | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = o.id !== undefined && o.id !== null ? String(o.id) : null;
  if (!id) return null;

  return {
    id,
    account,
    folder: asString(o.folder) ?? folder,
    messageId: asString(o['message-id']) ?? asString(o.message_id) ?? asString(o.messageId),
    inReplyTo: asString(o['in-reply-to']) ?? asString(o.in_reply_to) ?? asString(o.inReplyTo),
    subject: asString(o.subject) ?? '',
    fromAddr: addrToString(o.from),
    toAddrs: addrListToStrings(o.to),
    date: asString(o.date),
    rawJson: JSON.stringify(raw),
  };
}

/** himalaya returns either a bare array of envelopes or `{ envelopes: [...] }`. */
function extractEnvelopeArray(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') {
    const o = result as Record<string, unknown>;
    if (Array.isArray(o.envelopes)) return o.envelopes;
  }
  return [];
}

function upsertAll(deps: Deps, result: unknown, account: string, folder: string): MailEnvelope[] {
  const mapped: MailEnvelope[] = [];
  for (const raw of extractEnvelopeArray(result)) {
    const env = mapEnvelope(raw, account, folder);
    if (!env) continue;
    // fromAddr is NOT NULL in the schema; skip malformed rows rather than crash.
    if (!env.fromAddr) env.fromAddr = '';
    deps.store.upsertEnvelope(env);
    mapped.push(env);
  }
  return mapped;
}

// ---------------------------------------------------------------------------
// subcommand handlers — each returns the JSON value to print on stdout
// ---------------------------------------------------------------------------

/** `mailctl list [--folder <name>] [--limit <n>] [--account <name>]` */
export async function cmdList(argv: string[], deps: Deps): Promise<unknown> {
  const { flags } = parseArgs(argv, ['folder', 'limit', 'account']);
  const account = resolveAccount(flags);
  const folder = resolveFolder(flags);

  let limit: number | undefined;
  if (flags.limit !== undefined) {
    limit = Number(flags.limit);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new MailctlError(`--limit must be a positive integer, got "${flags.limit}"`);
    }
  }

  const args = ['envelope', 'list', '--folder', folder, ...(limit ? ['--page-size', String(limit)] : [])];
  const result = await deps.runHimalaya(args, { account });
  upsertAll(deps, result, account, folder);
  return result;
}

/** `mailctl search "<query>" [--folder <name>] [--account <name>]` */
export async function cmdSearch(argv: string[], deps: Deps): Promise<unknown> {
  const { positionals, flags } = parseArgs(argv, ['folder', 'account']);
  const query = positionals[0];
  if (!query) throw new MailctlError('search requires a query string');
  const account = resolveAccount(flags);
  const folder = resolveFolder(flags);

  const result = await deps.runHimalaya(['envelope', 'search', query, '--folder', folder], { account });
  upsertAll(deps, result, account, folder);
  return result;
}

/**
 * `mailctl read <id> [--folder <name>] [--account <name>]`
 *
 * Pure read: `--seen` is never passed, so this does not mutate flags on the
 * mail server.
 */
export async function cmdRead(argv: string[], deps: Deps): Promise<unknown> {
  const { positionals, flags } = parseArgs(argv, ['folder', 'account']);
  const id = positionals[0];
  if (!id) throw new MailctlError('read requires a message id');
  const account = resolveAccount(flags);
  const folder = resolveFolder(flags);

  return deps.runHimalaya(['message', 'read', id, '--folder', folder], { account });
}

/**
 * `mailctl thread <message-id> [--account <name>]`
 *
 * Pure local reconstruction from envelopes already cached by `list`/`search`.
 * Makes no himalaya calls.
 */
export async function cmdThread(argv: string[], deps: Deps): Promise<unknown> {
  const { positionals, flags } = parseArgs(argv, ['account']);
  const messageId = positionals[0];
  if (!messageId) throw new MailctlError('thread requires a message-id');
  void flags;

  const seed = deps.store.getEnvelopeByMessageId(messageId);
  if (!seed) {
    throw new MailctlError(
      `message-id "${messageId}" is not in the local store; run "mailctl list" or "mailctl search" first`,
    );
  }

  // Walk backwards along in-reply-to to find the root of the chain.
  const chain: MailEnvelope[] = [seed];
  const seen = new Set<string>([messageId]);
  let cursor: MailEnvelope | undefined = seed;
  while (cursor?.inReplyTo && !seen.has(cursor.inReplyTo)) {
    const parentId: string = cursor.inReplyTo;
    seen.add(parentId);
    const parent = deps.store.getEnvelopeByMessageId(parentId);
    if (!parent) break;
    chain.unshift(parent);
    cursor = parent;
  }

  return { messageId, count: chain.length, thread: chain };
}

/**
 * `mailctl context <id> [--account <name>]`
 *
 * Composite: the read message plus recent locally-cached envelopes from the
 * same sender.
 */
export async function cmdContext(argv: string[], deps: Deps): Promise<unknown> {
  const { positionals, flags } = parseArgs(argv, ['account', 'folder']);
  const id = positionals[0];
  if (!id) throw new MailctlError('context requires a message id');
  const account = resolveAccount(flags);
  const folder = resolveFolder(flags);

  const message = await deps.runHimalaya(['message', 'read', id, '--folder', folder], { account });

  let fromAddr: string | null = null;
  let recent: MailEnvelope[] = [];
  const anyStore = deps.store as MailctlStore & {
    listEnvelopesByFrom?: (addr: string, limit?: number) => MailEnvelope[];
  };
  const msgId = extractMessageId(message);
  const env = msgId ? deps.store.getEnvelopeByMessageId(msgId) : undefined;
  if (env) {
    fromAddr = env.fromAddr;
    if (typeof anyStore.listEnvelopesByFrom === 'function' && fromAddr) {
      recent = anyStore.listEnvelopesByFrom(fromAddr, 20);
    }
  }

  return { message, fromAddr, recentFromSender: recent };
}

function extractMessageId(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const o = message as Record<string, unknown>;
  return (
    asString(o['message-id']) ??
    asString(o.message_id) ??
    asString(o.messageId) ??
    (o.headers && typeof o.headers === 'object'
      ? asString((o.headers as Record<string, unknown>)['message-id'])
      : null)
  );
}

/**
 * Builds the kind-specific `ActionParams`.
 *
 * Note what is structurally impossible here: none of the returned shapes has a
 * `to`, `recipient`, `cc`, or `bcc` field, and no flag that could supply one is
 * in `propose`'s allow-list. A `reply` carries only a body.
 */
export function buildActionParams(kind: string, flags: Record<string, string>): ActionParams {
  switch (kind) {
    case 'archive':
      return { kind: 'archive' };
    case 'delete':
      return { kind: 'delete' };
    case 'move':
      return { kind: 'move', toFolder: requireFlag(flags, 'folder') };
    case 'flag': {
      const flag = requireFlag(flags, 'flag');
      const op = requireFlag(flags, 'op');
      if (!(VALID_FLAGS as readonly string[]).includes(flag)) {
        throw new MailctlError(`invalid --flag "${flag}" (expected one of: ${VALID_FLAGS.join(', ')})`);
      }
      if (!(VALID_OPS as readonly string[]).includes(op)) {
        throw new MailctlError(`invalid --op "${op}" (expected one of: ${VALID_OPS.join(', ')})`);
      }
      return { kind: 'flag', flag: flag as 'seen' | 'answered' | 'flagged' | 'draft', op: op as 'add' | 'remove' };
    }
    case 'reply':
      return { kind: 'reply', body: requireFlag(flags, 'body') };
    default:
      throw new MailctlError(
        `unknown kind "${kind}" (expected one of: ${VALID_KINDS.join(', ')})`,
      );
  }
}

/** `YYYY-MM-DD` in UTC. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function computeIdempotencyKey(sourceMessageId: string, kind: string, day: string): string {
  return crypto.createHash('sha256').update(`${sourceMessageId} ${kind} ${day}`).digest('hex');
}

/**
 * `mailctl propose --kind <...> --source-message-id <...> [kind params] --channel <...> --thread <...>`
 *
 * The ONLY write-shaped subcommand — and it writes only to local SQLite.
 * It never calls `runHimalaya` and never opens a network connection.
 */
export async function cmdPropose(argv: string[], deps: Deps): Promise<unknown> {
  // Deliberately narrow allow-list: no `to`, `recipient`, `cc`, or `bcc`.
  const { flags } = parseArgs(argv, [
    'kind',
    'source-message-id',
    'folder',
    'flag',
    'op',
    'body',
    'channel',
    'thread',
    'account',
  ]);

  const kind = requireFlag(flags, 'kind');
  const sourceMessageId = requireFlag(flags, 'source-message-id');
  const channel = requireFlag(flags, 'channel');
  const thread = requireFlag(flags, 'thread');

  // Validate the kind before anything else; `send` falls through to the
  // "unknown kind" error like any other invalid value.
  if (!(VALID_KINDS as readonly string[]).includes(kind)) {
    throw new MailctlError(`unknown kind "${kind}" (expected one of: ${VALID_KINDS.join(', ')})`);
  }

  const params = buildActionParams(kind, flags);
  const day = (deps.today ?? todayUtc)();
  const idempotencyKey = computeIdempotencyKey(sourceMessageId, kind, day);
  const actionId = crypto.randomUUID();

  try {
    deps.store.createProposedAction({
      actionId,
      idempotencyKey,
      kind: kind as ActionKind,
      sourceMessageId,
      paramsJson: JSON.stringify(params),
      slackChannelId: channel,
      slackThreadTs: thread,
      slackMessageTs: null,
    });
    return { action_id: actionId };
  } catch (err) {
    // Idempotent propose: same message + kind + day reuses the prior row.
    const existing = deps.store.getProposedActionByIdempotencyKey?.(idempotencyKey);
    if (existing) return { action_id: existing.actionId };
    throw new MailctlError(
      `failed to record proposed action: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

export type Subcommand = 'list' | 'search' | 'read' | 'thread' | 'context' | 'propose';

const HANDLERS: Record<Subcommand, (argv: string[], deps: Deps) => Promise<unknown>> = {
  list: cmdList,
  search: cmdSearch,
  read: cmdRead,
  thread: cmdThread,
  context: cmdContext,
  propose: cmdPropose,
};

export const SUBCOMMANDS = Object.keys(HANDLERS) as Subcommand[];

export async function dispatch(argv: string[], deps: Deps): Promise<unknown> {
  const [sub, ...rest] = argv;
  if (!sub) throw new MailctlError(`usage: mailctl <${SUBCOMMANDS.join('|')}> [args]`);
  const handler = HANDLERS[sub as Subcommand];
  if (!handler) {
    throw new MailctlError(`unknown subcommand "${sub}" (expected one of: ${SUBCOMMANDS.join(', ')})`);
  }
  return handler(rest, deps);
}

export function resolveDbPath(): string {
  return process.env.MAILCTL_DB_PATH ?? DEFAULT_DB_PATH;
}

/** Real entry point. Never throws — prints to stderr and returns an exit code. */
export async function main(argv: string[]): Promise<number> {
  let store: MailStore | undefined;
  try {
    store = new MailStore(resolveDbPath());
    const result = await dispatch(argv, { runHimalaya: realRunHimalaya, store });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`mailctl: ${message}\n`);
    return err instanceof MailctlError ? err.exitCode : 1;
  } finally {
    store?.close();
  }
}

const entry = process.argv[1] ? path.basename(process.argv[1]) : '';
const isDirectRun = entry === 'mailctl.js' || entry === 'mailctl' || entry === 'mailctl.ts';
if (isDirectRun) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`mailctl: unexpected error: ${String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
