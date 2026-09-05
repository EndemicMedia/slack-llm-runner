export interface MailEnvelope {
  id: string;            // himalaya envelope id, folder-scoped
  account: string;
  folder: string;
  messageId: string | null;    // RFC Message-ID
  inReplyTo: string | null;
  subject: string;
  fromAddr: string;      // authoritative recipient source for replies
  toAddrs: string[];
  date: string | null;
  rawJson: string;       // full himalaya envelope JSON as a string
}

export type ActionKind = 'archive' | 'move' | 'flag' | 'reply' | 'delete';

export type ActionParams =
  | { kind: 'archive' }
  | { kind: 'move'; toFolder: string }
  | { kind: 'flag'; flag: 'seen' | 'answered' | 'flagged' | 'draft'; op: 'add' | 'remove' }
  | { kind: 'reply'; body: string }
  | { kind: 'delete' };

export type ProposedActionStatus = 'pending' | 'approved' | 'executed' | 'rejected' | 'failed' | 'expired';

export interface ProposedAction {
  actionId: string;
  idempotencyKey: string;
  kind: ActionKind;
  sourceMessageId: string;      // references MailEnvelope.messageId
  paramsJson: string;           // JSON-serialized ActionParams
  status: ProposedActionStatus;
  slackChannelId: string;
  slackThreadTs: string;
  slackMessageTs: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  executedAt: string | null;
  error: string | null;
}

export interface MailDigestItem {
  sourceMessageId: string;
  subject: string;
  from: string;
  analysis: string;
  proposedActionId: string;
}

export interface MailDigest {
  summary: string;
  items: MailDigestItem[];
}
