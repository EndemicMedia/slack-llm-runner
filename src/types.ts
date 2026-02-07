/** Envelope message type emitted by LLM sessions */
export type EnvelopeType = 'progress' | 'question' | 'warning' | 'done' | 'error';

/** Parsed envelope extracted from PTY output */
export interface EnvelopeMessage {
  type: EnvelopeType | null;
  text: string;
  /** True when flushed without a close tag (process exit or timeout) */
  incomplete?: boolean;
}

/** Session execution mode */
export type SessionMode = 'interactive' | 'one-shot';

/** Current lifecycle state of a session */
export type SessionStatus = 'running' | 'exited' | 'timed_out';

/** CLI command configuration loaded from commands.yaml */
export interface CommandConfig {
  prefix: string;
  binary: string;
  args?: string[];
  mode: SessionMode;
  envelope: boolean;
  description: string;
  timeout?: boolean;      // false = no timeout, true/undefined = use default
  promptFlag?: string;    // e.g. "-p" — flag preceding the prompt text
  sessionFlag?: string;   // e.g. "-S" — flag for passing session ID (any string)
  sessionIdFlag?: string; // e.g. "--session-id" — flag for passing session ID as UUID
  resumeFlag?: string;    // e.g. "--resume" — flag for resuming a session
}

/** Single authorization rule from authorization.yaml */
export interface AuthRule {
  channels: string[];
  users: string[];
  allowed_prefixes: string[];
}

/** Scheduled job definition from jobs.yaml */
export interface JobDefinition {
  name: string;
  cron: string;
  command: string;
  channel: string;
  cwd?: string;
  label?: string;
}

/** Result of parsing a Slack message into a command */
export interface ParsedCommand {
  isControl: boolean;
  prefix: string;
  args: string;
}

/** Options for spawning a new CLI session */
export interface SessionSpawnOptions {
  channelId: string;
  threadTs: string;
  command: string;
  config: CommandConfig;
  cwd?: string;
  sessionId?: string;        // Kimi session ID for -S flag (session continuation)
  isContinuation?: boolean;  // true = skip "Session started" message
}

/** Full application configuration assembled at startup */
export interface AppConfig {
  slack: {
    appToken: string;
    botToken: string;
    listenChannels: string[];
  };
  auth: {
    allowedUserIds: string[];
    rules: AuthRule[];
  };
  cli: {
    claude: string;
    kimi: string;
  };
  behavior: {
    sessionTimeoutMinutes: number;
    outputFlushIntervalMs: number;
    outputMaxCharsPerMessage: number;
  };
  envelope: {
    promptFile: string;
    promptText: string;
    activationDelayMs: number;
    unclosedTimeoutMs: number;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    sessionRetentionDays: number;
  };
  commands: CommandConfig[];
  jobs: JobDefinition[];
}
