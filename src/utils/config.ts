import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { load } from 'js-yaml';
import { type AppConfig, type CommandConfig, type AuthRule, type JobDefinition } from '../types.js';
import { setLogLevel, type LogLevel } from './logger.js';

/** Reads and parses a YAML file from a path relative to cwd */
function loadYaml<T>(relativePath: string): T {
  return load(readFileSync(resolve(process.cwd(), relativePath), 'utf-8')) as T;
}

/** Returns the env var value or throws */
function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`[config] Missing required env var: ${name}`);
  return val;
}

/** Returns the env var value or a provided default */
function optEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

/**
 * Loads and validates the full application configuration from
 * .env, YAML config files, and the envelope prompt template.
 * Throws on any missing required value.
 */
export function loadConfig(): AppConfig {
  const commandsYaml = loadYaml<{ commands: (CommandConfig & { binary: string })[] }>('config/commands.yaml');
  const authYaml      = loadYaml<{ rules: AuthRule[] }>('config/authorization.yaml');
  const jobsYaml      = loadYaml<{ jobs?: JobDefinition[] }>('config/jobs.yaml');

  // Resolve ${VAR} placeholders in binary paths against process.env
  const commands: CommandConfig[] = commandsYaml.commands.map((cmd) => {
    const resolvedBinary = cmd.binary.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? key);
    console.log(`[config] Command ${cmd.prefix}: binary="${resolvedBinary}" envelope=${cmd.envelope} mode=${cmd.mode} promptFlag=${cmd.promptFlag} sessionFlag=${cmd.sessionFlag} sessionIdFlag=${cmd.sessionIdFlag} resumeFlag=${cmd.resumeFlag}`);
    return {
      ...cmd,
      binary: resolvedBinary,
    };
  });

  // Load envelope prompt template
  const promptFile = optEnv('ENVELOPE_PROMPT_FILE', 'config/prompts/envelope-instructions.txt');
  const promptPath = resolve(process.cwd(), promptFile);
  const promptText = existsSync(promptPath) ? readFileSync(promptPath, 'utf-8') : '';

  const logLevel = optEnv('LOG_LEVEL', 'debug') as LogLevel;
  setLogLevel(logLevel);

  return {
    slack: {
      appToken:       requireEnv('SLACK_APP_TOKEN'),
      botToken:       requireEnv('SLACK_BOT_TOKEN'),
      listenChannels: requireEnv('SLACK_LISTEN_CHANNELS').split(',').map((s) => s.trim()),
    },
    auth: {
      allowedUserIds: requireEnv('ALLOWED_USER_IDS').split(',').map((s) => s.trim()),
      rules:          authYaml.rules,
    },
    cli: {
      claude: optEnv('CLI_CLAUDE', 'claude'),
      kimi:   optEnv('CLI_KIMI',   'kimi'),
    },
    behavior: {
      sessionTimeoutMinutes:  Number(optEnv('SESSION_TIMEOUT_MINUTES',         '30')),
      outputFlushIntervalMs:  Number(optEnv('OUTPUT_FLUSH_INTERVAL_MS',        '2000')),
      outputMaxCharsPerMessage: Number(optEnv('OUTPUT_MAX_CHARS_PER_MESSAGE',  '3500')),
    },
    envelope: {
      promptFile,
      promptText,
      activationDelayMs:  Number(optEnv('ENVELOPE_ACTIVATION_DELAY_MS',  '1500')),
      unclosedTimeoutMs:  Number(optEnv('ENVELOPE_UNCLOSED_TIMEOUT_MS',  '30000')),
    },
    logging: {
      level:                 logLevel,
      sessionRetentionDays:  Number(optEnv('LOG_SESSION_RETENTION_DAYS', '30')),
    },
    commands,
    jobs: jobsYaml.jobs ?? [],
  };
}
