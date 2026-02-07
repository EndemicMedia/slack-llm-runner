# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npm run build          # tsc → dist/
npm run dev            # Run with tsx (development, no build step)
npm start              # Run compiled output (node dist/index.js)
npm test               # Run processHandle unit tests
npm run test:lifecycle # Run E2E session lifecycle tests
npm run clean          # Kill all node processes (Windows)
npm run restart        # clean + wait + dev
```

Run a single test file:
```bash
node --import tsx --test test/<file>.test.ts
```

## Architecture

This is a **bidirectional Slack-to-CLI bridge** that lets users trigger local CLI tools (Claude Code, Kimi, shell commands) from Slack messages and receive filtered output back in threads.

### Two Spawn Paths

Commands use one of two process-spawning strategies based on mode (configured in `config/commands.yaml`):

- **One-shot** (`run:`, `kimi:`) → `child_process.spawn` with piped stdio. Reliable on Windows. Process exits when command finishes.
- **Interactive** (`claude:`) → `node-pty` pseudo-terminal. Required for REPL-style CLIs that detect TTY. Session stays alive for follow-up input via Slack thread replies.

Both are abstracted behind `ProcessHandle` interface in `src/cli/processHandle.ts` (`SpawnHandle` / `PtyHandle`).

### Two-Track Output Model

Every byte from a spawned process hits two independent destinations simultaneously:

1. **LogWriter** (always on) — raw unfiltered output to `logs/sessions/<sessionId>.log`
2. **Slack channel** — routed through one of:
   - **EnvelopeParser** (LLM sessions with `envelope: true`) — scans for `<<<SLACK>>>...<<<END_SLACK>>>` markers in the output stream. Only enveloped text reaches Slack. The LLM decides what's important.
   - **FullStreamer** (shell sessions with `envelope: false`) — buffers all output and posts via `chat.update` loop every 2s, splitting at 3500 chars.

### Message Flow

```
Slack message → Bolt listener (src/slack/listener.ts)
  → CommandRouter (src/commands/router.ts) decision tree:
    1. Channel allowed? (authorizer)
    2. User allowed? (authorizer)
    3. Reply in active session thread? → forward as stdin
    4. Thread binding exists? → spawn continuation (Kimi -S session flag)
    5. Parse command prefix → spawn new session via SessionManager
```

### Session Continuation (Thread Bindings)

For CLIs with `sessionFlag` (e.g., Kimi's `-S`), the system creates a **thread binding** that persists after the process exits. Follow-up messages in the same Slack thread spawn a new one-shot process with the same session ID, enabling multi-turn conversations without a persistent process.

### Envelope Parser Activation Delay

The EnvelopeParser has a configurable activation delay (default 1500ms for interactive, 0 for one-shot) to skip the PTY echo of the injected system prompt, which contains marker examples that would trigger false envelope detection.

## Key Conventions

- **ESM project** (`"type": "module"`) with TypeScript `module: NodeNext`. All relative imports must use `.js` extension.
- **@slack/bolt v3.x** requires CommonJS workaround in ESM: `createRequire(import.meta.url)` in `src/slack/app.ts`.
- **Config resolution**: `config/commands.yaml` supports `${VAR}` placeholders resolved from `process.env` at startup.
- **Slack Web API type gaps**: `files.getUploadURLExternal` / `completeUploadToChannel` may lack types — cast via `as unknown as { ... }` in `src/slack/reporter.ts`.
- Structured logging via `createLogger('ModuleName')` from `src/utils/logger.ts` — use `logger.debug/info/warn/error`.

## Package Version Constraints

- `node-pty`: v1.1.0. Interface is `IPty`. `onExit` receives `{ exitCode, signal }` object.
- `node-cron`: v4.2.1 (ESM-native). Use named imports: `import { schedule, validate } from 'node-cron'`.
- `js-yaml`: v4. Use `import { load } from 'js-yaml'` (not `parse`).
- `@types/js-yaml`: max 4.0.9 — do not use `^4.1.x`.

## Environment

- Platform: Windows. Bash available at `/usr/bin/bash` (Git Bash).
- Socket Mode: only ONE active connection per app token. Kill all node processes before restarting (`taskkill /IM node.exe /F`).
- The envelope prompt template is at `prompts/envelope-instructions.txt` — editable without code changes.
