import Database, { type Database as DatabaseType, type Statement } from 'better-sqlite3';
import type {
  MailEnvelope,
  ProposedAction,
  ProposedActionStatus,
} from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mail_envelopes (
  id            TEXT PRIMARY KEY,
  account       TEXT NOT NULL,
  folder        TEXT NOT NULL,
  message_id    TEXT,
  in_reply_to   TEXT,
  subject       TEXT,
  from_addr     TEXT NOT NULL,
  to_addrs      TEXT,
  date          TEXT,
  raw_json      TEXT NOT NULL,
  fetched_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_envelopes_message_id ON mail_envelopes(message_id);

CREATE TABLE IF NOT EXISTS proposed_actions (
  action_id       TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('archive','move','flag','reply','delete')),
  source_message_id TEXT NOT NULL,
  params_json     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','executed','rejected','failed','expired')),
  slack_channel_id TEXT NOT NULL,
  slack_thread_ts  TEXT NOT NULL,
  slack_message_ts TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at      TEXT,
  decided_by      TEXT,
  executed_at     TEXT,
  error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_actions_status ON proposed_actions(status);
`;

interface EnvelopeRow {
  id: string;
  account: string;
  folder: string;
  message_id: string | null;
  in_reply_to: string | null;
  subject: string | null;
  from_addr: string;
  to_addrs: string | null;
  date: string | null;
  raw_json: string;
  fetched_at: string;
}

interface ProposedActionRow {
  action_id: string;
  idempotency_key: string;
  kind: string;
  source_message_id: string;
  params_json: string;
  status: string;
  slack_channel_id: string;
  slack_thread_ts: string;
  slack_message_ts: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  executed_at: string | null;
  error: string | null;
}

function rowToEnvelope(row: EnvelopeRow): MailEnvelope {
  return {
    id: row.id,
    account: row.account,
    folder: row.folder,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    subject: row.subject ?? '',
    fromAddr: row.from_addr,
    toAddrs: row.to_addrs ? JSON.parse(row.to_addrs) : [],
    date: row.date,
    rawJson: row.raw_json,
  };
}

function rowToProposedAction(row: ProposedActionRow): ProposedAction {
  return {
    actionId: row.action_id,
    idempotencyKey: row.idempotency_key,
    kind: row.kind as ProposedAction['kind'],
    sourceMessageId: row.source_message_id,
    paramsJson: row.params_json,
    status: row.status as ProposedActionStatus,
    slackChannelId: row.slack_channel_id,
    slackThreadTs: row.slack_thread_ts,
    slackMessageTs: row.slack_message_ts,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    executedAt: row.executed_at,
    error: row.error,
  };
}

export type NewProposedAction = Omit<
  ProposedAction,
  'createdAt' | 'decidedAt' | 'decidedBy' | 'executedAt' | 'error' | 'status'
>;

export class MailStore {
  private db: DatabaseType;

  private upsertEnvelopeStmt: Statement;
  private getEnvelopeStmt: Statement;
  private getEnvelopeByMessageIdStmt: Statement;
  private listEnvelopesByFromStmt: Statement;
  private createProposedActionStmt: Statement;
  private getProposedActionByIdempotencyKeyStmt: Statement;
  private getProposedActionStmt: Statement;
  private markDecidedStmt: Statement;
  private markExecutedStmt: Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);

    this.upsertEnvelopeStmt = this.db.prepare(`
      INSERT INTO mail_envelopes (id, account, folder, message_id, in_reply_to, subject, from_addr, to_addrs, date, raw_json)
      VALUES (@id, @account, @folder, @message_id, @in_reply_to, @subject, @from_addr, @to_addrs, @date, @raw_json)
      ON CONFLICT(id) DO UPDATE SET
        account = excluded.account,
        folder = excluded.folder,
        message_id = excluded.message_id,
        in_reply_to = excluded.in_reply_to,
        subject = excluded.subject,
        from_addr = excluded.from_addr,
        to_addrs = excluded.to_addrs,
        date = excluded.date,
        raw_json = excluded.raw_json
    `);

    this.getEnvelopeStmt = this.db.prepare(`SELECT * FROM mail_envelopes WHERE id = ?`);
    this.getEnvelopeByMessageIdStmt = this.db.prepare(`SELECT * FROM mail_envelopes WHERE message_id = ?`);
    this.listEnvelopesByFromStmt = this.db.prepare(
      `SELECT * FROM mail_envelopes WHERE from_addr = ? ORDER BY date DESC LIMIT ?`,
    );

    this.createProposedActionStmt = this.db.prepare(`
      INSERT INTO proposed_actions (
        action_id, idempotency_key, kind, source_message_id, params_json,
        slack_channel_id, slack_thread_ts, slack_message_ts
      ) VALUES (
        @action_id, @idempotency_key, @kind, @source_message_id, @params_json,
        @slack_channel_id, @slack_thread_ts, @slack_message_ts
      )
    `);

    this.getProposedActionStmt = this.db.prepare(`SELECT * FROM proposed_actions WHERE action_id = ?`);
    this.getProposedActionByIdempotencyKeyStmt = this.db.prepare(
      `SELECT * FROM proposed_actions WHERE idempotency_key = ?`,
    );

    this.markDecidedStmt = this.db.prepare(`
      UPDATE proposed_actions
      SET status = @status, decided_at = datetime('now'), decided_by = @decided_by
      WHERE action_id = @action_id
    `);

    this.markExecutedStmt = this.db.prepare(`
      UPDATE proposed_actions
      SET status = @status, executed_at = datetime('now'), error = @error
      WHERE action_id = @action_id
    `);
  }

  close(): void {
    this.db.close();
  }

  upsertEnvelope(env: MailEnvelope): void {
    this.upsertEnvelopeStmt.run({
      id: env.id,
      account: env.account,
      folder: env.folder,
      message_id: env.messageId,
      in_reply_to: env.inReplyTo,
      subject: env.subject,
      from_addr: env.fromAddr,
      to_addrs: JSON.stringify(env.toAddrs ?? []),
      date: env.date,
      raw_json: env.rawJson,
    });
  }

  getEnvelope(id: string): MailEnvelope | undefined {
    const row = this.getEnvelopeStmt.get(id) as EnvelopeRow | undefined;
    return row ? rowToEnvelope(row) : undefined;
  }

  getEnvelopeByMessageId(messageId: string): MailEnvelope | undefined {
    const row = this.getEnvelopeByMessageIdStmt.get(messageId) as EnvelopeRow | undefined;
    return row ? rowToEnvelope(row) : undefined;
  }

  /** Most recent envelopes from a given sender address (local cache only). */
  listEnvelopesByFrom(fromAddr: string, limit = 20): MailEnvelope[] {
    const rows = this.listEnvelopesByFromStmt.all(fromAddr, limit) as EnvelopeRow[];
    return rows.map(rowToEnvelope);
  }

  createProposedAction(a: NewProposedAction): string {
    try {
      this.createProposedActionStmt.run({
        action_id: a.actionId,
        idempotency_key: a.idempotencyKey,
        kind: a.kind,
        source_message_id: a.sourceMessageId,
        params_json: a.paramsJson,
        slack_channel_id: a.slackChannelId,
        slack_thread_ts: a.slackThreadTs,
        slack_message_ts: a.slackMessageTs,
      });
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed: proposed_actions\.idempotency_key/.test(err.message)) {
        throw new Error(`Proposed action with idempotencyKey "${a.idempotencyKey}" already exists`);
      }
      throw err;
    }
    return a.actionId;
  }

  getProposedAction(actionId: string): ProposedAction | undefined {
    const row = this.getProposedActionStmt.get(actionId) as ProposedActionRow | undefined;
    return row ? rowToProposedAction(row) : undefined;
  }

  /** Looks up an action by its idempotency key — used for idempotent re-proposal. */
  getProposedActionByIdempotencyKey(key: string): ProposedAction | undefined {
    const row = this.getProposedActionByIdempotencyKeyStmt.get(key) as ProposedActionRow | undefined;
    return row ? rowToProposedAction(row) : undefined;
  }

  markDecided(actionId: string, status: 'approved' | 'rejected', userId: string): void {
    this.markDecidedStmt.run({ action_id: actionId, status, decided_by: userId });
  }

  markExecuted(actionId: string, status: 'executed' | 'failed', error?: string): void {
    this.markExecutedStmt.run({ action_id: actionId, status, error: error ?? null });
  }
}
