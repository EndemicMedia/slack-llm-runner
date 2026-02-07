# Slack CLI Wrapper — Architecture & Development Document

## Table of Contents

1. [Overview & Problem Statement](#1-overview--problem-statement)
2. [Requirements](#2-requirements)
3. [Technology Stack](#3-technology-stack)
4. [System Architecture](#4-system-architecture)
5. [Component Breakdown](#5-component-breakdown)
6. [Slack API Configuration](#6-slack-api-configuration)
7. [CLI Execution Engine](#7-cli-execution-engine)
8. [Output Handling — The Two-Track Model](#8-output-handling--the-two-track-model)
9. [Scheduling & Outbound Triggers](#9-scheduling--outbound-triggers)
10. [Command Language & Parsing](#10-command-language--parsing)
11. [Security Model](#11-security-model)
12. [Rate Limiting & Resilience](#12-rate-limiting--resilience)
13. [Project Structure](#13-project-structure)
14. [Environment & Configuration](#14-environment--configuration)
15. [Implementation Roadmap](#15-implementation-roadmap)
16. [Key Trade-offs & Decisions](#16-key-trade-offs--decisions)

---

## 1. Overview & Problem Statement

This system is a **bidirectional bridge** between Slack and one or more CLI tools
(Claude Code, Kimi Code, or any shell command) running on a local machine.

The two communication directions are fundamentally different in how they are
triggered, and the architecture must handle both cleanly:

```
INBOUND  (Slack → Local)   — User types a command in Slack → system executes it
OUTBOUND (Local → Slack)   — Cron job or event fires locally → system reports to Slack
```

For LLM CLI sessions (Claude Code, Kimi Code), output is **not** blindly
streamed to Slack. Instead, the LLM itself decides what is worth reporting,
using a structured envelope protocol embedded in its output. Everything else
is logged locally and retrievable on demand. One-shot shell commands retain
full output forwarding.

---

## 2. Requirements

### 2.1 Functional

| ID  | Requirement |
|-----|-------------|
| F01 | Listen to messages in one or more designated Slack channels |
| F02 | Parse incoming messages to extract CLI commands |
| F03 | Spawn the target CLI (claude, kimi, or arbitrary shell command) |
| F04 | For one-shot shell commands: stream full stdout/stderr back to Slack |
| F05 | Support interactive CLIs that expect stdin input (e.g. Claude Code prompts) |
| F06 | Allow users to send follow-up input to a running CLI session via Slack |
| F07 | Support scheduled (cron) triggers that start a CLI and report output |
| F08 | Support multiple concurrent CLI sessions (tagged by thread) |
| F09 | Gracefully handle CLI exit, errors, and timeouts |
| F10 | Notify the channel when a session starts and when it finishes |
| F11 | For LLM CLI sessions: inject a prompt that instructs the LLM to use envelope markers for Slack-bound messages. Forward only enveloped output to Slack. |
| F12 | Log all CLI output to a local file regardless of envelope status |
| F13 | Provide an on-demand `/logs` command that retrieves the full session log |

### 2.2 Non-Functional

| ID  | Requirement |
|-----|-------------|
| N01 | Must work entirely locally — no cloud deployment required |
| N02 | No need for a publicly reachable URL (Socket Mode) |
| N03 | Slack message rate limits must be respected |
| N04 | Only authorized Slack users / channels may trigger commands |
| N05 | Secrets (tokens, signing secrets) must not be in source code |
| N06 | Must survive the process restart — in-flight sessions can be lost, but the
|     | listener must reconnect automatically |

---

## 3. Technology Stack

### 3.1 Why These Choices

| Layer | Package | Why |
|-------|---------|-----|
| Slack framework | `@slack/bolt` | Official Slack framework. Handles signature verification, event routing, and ack() automatically. Socket Mode is first-class. |
| Slack Web API | `@slack/web-api` (bundled in Bolt) | `chat.postMessage`, `chat.update`, and the new streaming methods (`chat.startStream` / `chat.appendStream` / `chat.stopStream`) |
| Slack Webhooks | `@slack/webhook` | Lightweight fallback for one-way notifications if a simpler path is needed for outbound-only alerts |
| CLI process | `node-pty` | Pseudo-terminal. Required because Claude Code and similar tools detect whether stdout is a TTY and change behavior (color, prompts, interactive mode). `child_process.spawn` alone will cause many CLIs to drop into non-interactive / piped mode. |
| Scheduling | `node-cron` | Lightweight, pure-JS, standard cron syntax. Jobs live as long as the process does, which is the intended model here (the wrapper IS the long-running process). |
| Config | `dotenv` | `.env` file for secrets, never committed. |
| Runtime | Node.js 20+ | LTS, native ESM, good stream support. |

### 3.2 What Was Considered and Rejected

| Option | Rejected Because |
|--------|-----------------|
| RTM API (`@slack/rtm-api`) | Deprecated. Not available for granular-permission apps. Slack explicitly recommends Events API + Web API instead. |
| Outgoing Webhooks | Legacy feature. Only works for slash commands, not general channel messages. |
| Incoming Webhooks only | One-directional (POST to Slack only). Cannot listen for messages. Useful as a *supplement* for simple outbound alerts, not as the main channel. |
| `child_process.spawn` only | Fails for interactive CLIs. Claude Code requires a TTY to enter its REPL. `node-pty` is the correct solution. |
| Cloud deployment (Lambda, Heroku) | Requirement N01: the CLI tools run locally and need filesystem / terminal access. The wrapper must be local. |

---

## 4. System Architecture

### 4.1 High-Level Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           LOCAL MACHINE                                  │
│                                                                          │
│  ┌──────────┐    ┌──────────────┐    ┌─────────────────────────┐        │
│  │  Cron    │───▶│              │    │                         │        │
│  │ Scheduler│    │   Command    │───▶│    CLI Runner (PTY)     │        │
│  └──────────┘    │   Router     │    │  ┌─────────────────┐   │        │
│                  │              │◀───│  │  claude code    │   │        │
│  ┌──────────┐    │              │    │  │  kimi code      │   │        │
│  │  Slack   │───▶│              │    │  │  shell cmd      │   │        │
│  │ Listener │    └──────────────┘    │  └─────────────────┘   │        │
│  │(Bolt app)│                        └────────┬────────────────┘        │
│  └────┬─────┘                                 │ raw stdout/stderr       │
│       │                                       ▼                         │
│       │                              ┌─────────────────┐                │
│       │                              │  Log Writer     │                │
│       │                              │  (always on,    │                │
│       │                              │   every session)│                │
│       │                              └────────┬────────┘                │
│       │                                       │ also tees to:           │
│       │                                       ▼                         │
│       │                              ┌─────────────────┐                │
│       │                              │  Output Router  │                │
│       │                              │  ┌────────────┐ │                │
│       │                              │  │  LLM mode: │ │                │
│       │                              │  │  Envelope  │ │                │
│       │                              │  │  Parser    │ │                │
│       │                              │  └─────┬──────┘ │                │
│       │                              │  ┌─────┴──────┐ │                │
│       │                              │  │Shell mode: │ │                │
│       │                              │  │  Full out  │ │                │
│       │                              │  │  Streamer  │ │                │
│       │                              │  └────────────┘ │                │
│       │                              └────────┬────────┘                │
│       │                                       │ only Slack-bound text   │
│       ▼                                       ▼                         │
│  ┌─────────────────────────────────────────────────┐                    │
│  │              Slack Web API Client               │                    │
│  │  chat.postMessage / chat.update / chat.Stream   │                    │
│  └──────────────────────┬──────────────────────────┘                    │
│                         │                                               │
└─────────────────────────┼───────────────────────────────────────────────┘
                          │  HTTPS (WebSocket for Socket Mode inbound;
                          │          REST for outbound API calls)
                          ▼
                   ┌──────────────┐
                   │    SLACK     │
                   │   (Cloud)    │
                   └──────┬───────┘
                          │
                          ▼
                   ┌──────────────┐
                   │   User sees  │
                   │   messages   │
                   └──────────────┘
```

### 4.2 Connection Model

The system uses **two different Slack transport mechanisms simultaneously**:

1. **Socket Mode (WebSocket, inbound)** — Bolt opens a persistent WebSocket
   connection to Slack's infrastructure. Slack pushes Events API payloads over
   this connection. No public URL is needed. This is how the system *receives*
   messages.

2. **Web API (HTTPS REST, outbound)** — When the system needs to *send* a
   message or update one, it makes standard HTTPS POST calls to Slack's
   Web API endpoints. This is how the system *writes* to channels.

These are not mutually exclusive. They are the designed, recommended pattern
for local / private deployments.

### 4.3 Session Model

Each CLI invocation is a **session**. Sessions are identified by the Slack
message thread timestamp (`ts`). All output for a given session goes into
replies within that thread. This means:

- Multiple sessions can run concurrently.
- Users can send follow-up commands to a specific session by replying in its thread.
- Output is visually grouped and easy to find.

#### Session Continuation (AI CLIs)

For AI CLIs (Claude, Kimi), sessions support **continuation** — follow-up
messages in the same thread resume the previous conversation with full context:

| CLI | First Call | Follow-up Call | Session ID Format |
|-----|------------|----------------|-------------------|
| **Kimi** | `-S <id>` | `-S <id>` (same) | Plain string: `slack-<channel>-<thread>` |
| **Claude** | `--session-id <uuid>` | `--resume <uuid>` | UUID v5 hash of `slack-<channel>-<thread>` |

**Thread Binding:** When a session with session continuation ends, a "thread
binding" is stored mapping `channel:thread` → `sessionId`. Subsequent replies
in that thread spawn a **new process** with the session ID, allowing the AI
to resume with full context while keeping the wrapper's one-shot execution model.

```
#channel
│
├── [User] claude: refactor auth module
│   ├── [Bot] 🚀 Session started (claude code) — logs: session_20260205_143022.log
│   │
│   │   [Claude Code is working. Reads files, writes code, runs tests.
│   │    All of that goes to the log file only. Nothing posted here.]
│   │
│   ├── [Bot] 🔄 Refactored authenticate() and updated 4 callers.
│   │         Tests pass. See /logs for full detail.
│   ├── [Bot] ✅ Session complete (exit code 0)
│   │
│   │   ← Only 2 messages from Claude's entire session appeared here.
│   │     The rest (file reads, diffs, test output) is in the log.
│
├── [User] run: docker ps
│   ├── [Bot] 🚀 Session started (shell)
│   ├── [Bot] `CONTAINER ID   IMAGE   STATUS ...`     ← full output, no LLM to filter
│   ├── [Bot] ✅ Session complete (exit code 0)
│
├── [User] /logs                                      ← retrieves full log on demand
│   ├── [Bot] 📎 [session_20260205_143022.log] (uploaded as attachment)
```

---

## 5. Component Breakdown

### 5.1 SlackListener (Bolt App)

**Responsibility:** Connect to Slack via Socket Mode, receive events, route them.

- Initializes the Bolt app with `socketMode: true`.
- Registers a `message` listener that filters by configured channel IDs.
- Extracts the text and metadata, then hands off to the Command Router.
- Also registers listeners for `app_mention` as a secondary trigger path.
- Calls `ack()` immediately to tell Slack the event was received (required).

**Key constraint:** The `ack()` function must be called within 3 seconds or Slack
will retry the event. All heavy work (spawning CLI, etc.) must be done *after*
ack, not blocking it.

### 5.2 Command Router

**Responsibility:** Decide what to do with an incoming message.

Decision tree:
```
Is the message in an authorized channel?   → No  → ignore
Is it from an authorized user?             → No  → reply "not authorized"
Is it a reply with a thread binding?       → Yes → spawn continuation (AI CLI resume)
Is it a reply in an active session thread? → Yes → send text as stdin to that session
Does it match a CLI trigger prefix?        → Yes → spawn new CLI session
Is it a control command (/status, /stop)?  → Yes → handle inline
Otherwise                                  → ignore (or reply "unknown command")
```

**Thread Bindings vs Active Sessions:** Thread bindings (for AI CLI session
continuation) take precedence over active sessions. This allows one-shot AI
CLIs like Claude to resume conversations by spawning new processes with
`--resume`, rather than keeping a long-running process alive.

### 5.3 CLI Runner (Session Manager)

**Responsibility:** Own the lifecycle of every CLI process.

- Maintains a `Map<string, Session>` where the key is the Slack thread `ts`.
- Each `Session` holds: the `node-pty` instance, the channel ID, start time,
  the CLI command that was run, and a reference to the Output Streamer.
- On spawn: creates a PTY. For LLM CLI sessions, prepends the envelope
  system prompt before the user's command (see Section 8). Begins piping
  stdout to the Log Writer and the Output Router.
- On stdin input (follow-up message in thread): writes to the PTY's stdin.
- On exit: fires a completion event, posts a "session complete" message, and
  removes the session from the map.
- On timeout: kills the process after a configurable limit (e.g. 30 minutes).

### 5.4 Output Router

**Responsibility:** Decide, per session, which output path to use.

Every raw byte from the PTY hits two destinations simultaneously:
1. The **Log Writer** — always, unconditionally. (See 5.7)
2. The **Output Router** — decides what, if anything, goes to Slack.

The router branches based on session type:

| Session type | Output to Slack |
|--------------|-----------------|
| LLM interactive (claude, kimi) | Envelope Parser extracts only enveloped messages |
| One-shot shell (`run:`) | Full Output Streamer sends everything |
| Scheduled job | Full Output Streamer sends everything |

### 5.5 Envelope Parser (LLM sessions)

**Responsibility:** Scan the PTY byte stream for envelope markers and extract
the messages inside them. Everything outside envelopes is silently discarded
(it already went to the log).

See Section 8 for the full protocol, parser state machine, and edge-case
handling.

### 5.6 Full Output Streamer (shell / cron sessions)

**Responsibility:** Take raw CLI output and turn it into well-timed Slack
messages. Used for one-shot and scheduled commands where there is no LLM
to make selective decisions.

Strategy (in priority order):

1. **Batched `chat.update`**
   - Post an initial "Running..." message.
   - Accumulate output in a buffer.
   - Every N milliseconds (configurable, default 2000ms), update that single
     Slack message with the latest buffer content, wrapped in a code block.

2. **Long output splitting**
   - Slack messages have a 40,000-character limit.
   - If the buffer exceeds a threshold (e.g. 3,500 chars per code block, to
     stay visually reasonable), post a new message and start a new buffer.

**Output sanitization** (applied here and in the Envelope Parser):
- Strip ANSI escape codes (colors, cursor movement) before sending to Slack.
- Preserve line structure.
- Wrap in ` ``` ` code blocks (using `rich_text_preformatted` in Block Kit
  for best rendering).

### 5.7 Log Writer

**Responsibility:** Persist every byte of every session to disk, always.

- Opens a file per session: `logs/sessions/<sessionId>.log`
- Writes raw PTY output as it arrives. No filtering, no ANSI stripping.
  The log is a faithful record of exactly what the terminal produced.
- On session end, writes a final metadata line: timestamp, exit code,
  duration.
- Logs are retained for a configurable period (default: 30 days).
  A cleanup job runs on startup to remove old logs.

### 5.8 Scheduler

**Responsibility:** Trigger CLI commands on a schedule.

- Reads job definitions from a config file (`jobs.yaml` or equivalent).
- Each job has: a cron expression, a CLI command, a target channel, and
  an optional label.
- When a job fires, it creates a new session via the CLI Runner, posts a
  "scheduled job started" message to the target channel, and lets the
  Full Output Streamer handle the rest.

### 5.9 Configuration & Secret Manager

**Responsibility:** Load and validate all configuration.

- Uses `dotenv` to load `.env` at startup.
- Validates that required env vars are present before starting.
- Loads `jobs.yaml` for scheduled job definitions.
- Loads an authorization config (allowed users, allowed channels, command
  allowlist).

---

## 6. Slack API Configuration

### 6.1 App Setup (One-Time, Manual)

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App →
   choose **"From scratch"** (not from a manifest, so you have full control).

2. **Socket Mode:** In the left sidebar → Socket Mode → Toggle ON.

3. **App-Level Token:** Basic Information → scroll to *App-Level Tokens* →
   Generate Token and Scopes → add scope `connections:write` → Generate.
   This gives you an `xapp-*` token. Save it.

4. **Bot Token Scopes:** OAuth & Permissions → Bot Token Scopes → Add the
   following:

   | Scope | Why |
   |-------|-----|
   | `chat:write` | Post and update messages |
   | `channels:read` | List channels (to validate config) |
   | `channels:history` | Read channel history (needed for context if desired) |
   | `reactions:write` | Optional: add reaction (e.g. ⏳) to acknowledge |
   | `users:read` | Resolve user IDs to display names in logs |

5. **Event Subscriptions:** Events → Subscribe to Bot Events → Add:
   - `message.channels` — messages in public channels
   - `message.groups` — messages in private channels (if needed)
   - `message.im` — direct messages to the bot (optional)

6. **Install the App:** OAuth & Permissions → Install to Workspace.
   Copy the **Bot User OAuth Token** (`xoxb-*`). Save it.

### 6.2 Tokens Summary

| Token | Env Var | Starts With | Purpose |
|-------|---------|-------------|---------|
| App Token | `SLACK_APP_TOKEN` | `xapp-` | Socket Mode WebSocket connection |
| Bot Token | `SLACK_BOT_TOKEN` | `xoxb-` | Web API calls (post, update messages) |

You do **not** need a Signing Secret when using Socket Mode with Bolt — Bolt
handles the WebSocket authentication via the app token. If you ever switch to
HTTP mode, you will need it.

### 6.3 Finding Channel IDs

You need channel IDs (not names) for the config. Use:
```bash
# Install @slack/web-api or just use curl:
curl -s -H "Authorization: Bearer xoxb-YOUR-TOKEN" \
     "https://slack.com/api/channels.list" | jq '.channels[] | {id, name}'
```
Or use the Slack UI: open the channel → click the channel name at the top →
the URL or info panel will show the channel ID (starts with `C`).

---

## 7. CLI Execution Engine

### 7.1 Why node-pty, Not child_process.spawn

Many CLI tools (Claude Code included) check whether their stdout is a TTY.
If it is not (i.e. if stdout is a pipe, as with `spawn`), they may:

- Disable colors and formatting
- Disable interactive prompts
- Change output structure entirely
- Exit immediately instead of entering a REPL

`node-pty` creates a **pseudo-terminal** — the child process *thinks* it is
running in a real terminal. This is the same mechanism VS Code uses to run
its integrated terminal.

### 7.2 PTY Configuration

```
PTY options:
  name:    'xterm-256color'    // terminal type
  cols:    220                 // wide enough to avoid wrapping in most outputs
  rows:    50
  cwd:     configurable per-job (defaults to user's home or project dir)
  env:     inherits process.env, can be overridden per-session
```

### 7.3 Lifecycle

```
User sends "claude: refactor auth"
         │
         ▼
  pty.spawn('claude', [], { ... })
         │
         ▼
  pty.on('data') ──────┬──────────────────▶ Log Writer (always)
         │             │
         │             └─────────────────▶ Envelope Parser (LLM sessions)
         │                                       │
         │                                       ▼ (only enveloped text)
         │                                 Slack Web API
         │
  pty.write(ENVELOPE_SYSTEM_PROMPT + '\n')   ← injected BEFORE user input
  pty.write('refactor auth\n')               ← actual user command
         │
         ▼
  [Claude Code runs, outputs text, some wrapped in <<<SLACK>>>]
         │
  User replies in thread: "yes, apply changes"
         │
         ▼
  pty.write('yes, apply changes\n')          (stdin injection, no prefix needed)
         │
         ▼
  [Claude Code finishes]
         │
  pty.on('exit') ──▶ Post completion message, close log file, clean up session
```

### 7.4 Two Execution Modes

| Mode | Trigger | How it works |
|------|---------|--------------|
| **Interactive** | User sends a message starting with a CLI prefix (e.g. `claude:`) | PTY is spawned. The message text after the prefix is written as the first input. The session stays alive — user can send more input by replying in the thread. |
| **One-shot** | User sends a plain shell command (e.g. `run: docker ps`) or a cron job fires | PTY is spawned with the full command as the argument. Session ends when the process exits. No stdin is expected. |

---

## 8. Output Handling — The Two-Track Model

### 8.1 The Core Idea

Streaming all CLI output to Slack is noisy. Claude Code working on a real
task might produce hundreds of lines — file reads, diffs, test runs, internal
reasoning traces. The user doesn't need to see most of it in real time.
They need to see **what matters**: a summary when it's done, a question
when it needs a decision, a warning when something went wrong.

The solution: **let the LLM decide what to forward.**

We inject a system prompt that gives the LLM a structured protocol for
flagging output as "send this to Slack." Everything else goes to a log file
and is retrievable on demand. The LLM is already the best judge of what is
relevant to the user — we just give it the mechanism to act on that judgment.

### 8.2 The Two Tracks

Every byte of PTY output splits into two paths at the moment it arrives:

```
PTY stdout
    │
    ├──────────────────────────────────────────────┐
    │                                              │
    ▼                                              ▼
 Track 1: LOG                                Track 2: SLACK
 ─────────────                               ──────────────
 Write everything to                         LLM session?
 session log file.                               │
 Raw, unfiltered,                         ┌──────┴──────┐
 including ANSI codes.                   Yes            No
 Always on.                               │              │
                                          ▼              ▼
                                    Envelope      Full Output
                                    Parser        Streamer
                                    (extract      (buffer +
                                     tagged        chat.update
                                     messages)     loop)
```

Track 1 and Track 2 are independent. Track 1 never fails silently — if
Track 2 hits a Slack rate limit or API error, the output is already safe
on disk.

### 8.3 The Envelope Protocol

This is the contract between the wrapper and the LLM. It is taught to the
LLM via the injected system prompt (Section 8.5).

**Markers:**
```
<<<SLACK>>>          — opens an envelope (plain message)
<<<SLACK:type>>>     — opens a typed envelope
<<<END_SLACK>>>      — closes the envelope
```

**Supported types and their Slack rendering:**

| Type | When to use | Slack prefix |
|------|-------------|--------------|
| *(none)* | General updates | (none) |
| `progress` | Work-in-progress status | 🔄 |
| `question` | Needs user input to continue | 🤔 |
| `warning` | Something unexpected | ⚠️ |
| `done` | Session summary / completion | ✅ |
| `error` | Something failed | ❌ |

**Example — what the LLM actually outputs in the terminal:**
```
Reading auth/index.ts...
Parsing 847 lines...
Found 3 functions matching the pattern.
<<<SLACK:progress>>>
Analyzed auth module. Found 3 functions to refactor:
  - authenticate()
  - validateToken()
  - refreshSession()
Starting refactor now.
<<<END_SLACK>>>
Writing auth/index.ts...
Running tests...
... (dozens more lines of work) ...
<<<SLACK:done>>>
Refactor complete. All 47 tests pass.
Changes: auth/index.ts (3 functions), auth/middleware.ts (4 call sites updated).
<<<END_SLACK>>>
```

**What appears in Slack:**
```
🔄 Analyzed auth module. Found 3 functions to refactor:
     authenticate()
     validateToken()
     refreshSession()
   Starting refactor now.

✅ Refactor complete. All 47 tests pass.
   Changes: auth/index.ts (3 functions), auth/middleware.ts (4 call sites updated).
```

Everything else — the file reads, the test output, the intermediate steps —
went to the log only.

### 8.4 Envelope Parser — Implementation Details

The parser is a **stateful stream processor**. It must handle the reality
that PTY `data` events do not respect any boundaries — a single marker
can arrive split across multiple events.

**State machine:**

```
State: SCANNING                    State: CAPTURING
─────────────────                  ────────────────
Looking for <<<SLACK              Accumulating text into
(possibly split across             the current envelope.
 data events).                     Looking for <<<END_SLACK>>>
                                   (also possibly split).
       │                                  │
       │ found <<<SLACK>>>               │ found <<<END_SLACK>>>
       │ or <<<SLACK:type>>>            │
       ▼                                  ▼
  → switch to CAPTURING            → emit envelope event
  → record the type                   (text + type)
                                   → switch to SCANNING
```

**Buffer design:**
```
class EnvelopeParser {
  state: 'scanning' | 'capturing'
  scanBuffer: string       // holds partial data while looking for open tag
  captureBuffer: string    // holds content between open and close tags
  currentType: string      // the type from the open tag, or null
  activationDelay: number  // ms to wait after spawn before parsing starts
  activated: boolean       // false until activationDelay has elapsed
}
```

**Activation delay — solving the PTY echo problem:**

When we write the system prompt to the PTY, the PTY echoes it back on
stdout. That echo contains our example markers. If the parser is active
immediately, it would see those examples as real envelopes and forward
garbage to Slack.

Solution: the parser has an `activationDelay` (default: 1500ms). It ignores
all output until this delay has elapsed after the initial prompt write. By
that time the echo has passed through. The LLM hasn't started generating
output yet (inference takes longer than 1.5s). This is simple, robust, and
does not require byte-level echo tracking.

The delay is configurable. If a specific LLM CLI starts outputting very
quickly, it can be tuned down.

**Handling unclosed envelopes:**

If the LLM outputs `<<<SLACK>>>` but never outputs `<<<END_SLACK>>>` before
the process exits, the parser flushes whatever it captured as a partial
envelope, tagged with a `⚠️ (incomplete)` prefix, so the user still sees it.

If the LLM is still running but has been in CAPTURING state for longer than
a configurable timeout (default: 30 seconds without a close tag), the parser
flushes the partial content and resets to SCANNING.

**Case sensitivity:**

The parser matches the open tag case-insensitively (`<<<slack>>>`,
`<<<Slack>>>`, `<<<SLACK>>>` all match). The close tag likewise. This
accounts for LLM inconsistency in casing.

### 8.5 The Injected System Prompt

This is the text prepended to the user's command before it is written to
the PTY. It is loaded from a configurable template file (`prompts/envelope-instructions.txt`),
so it can be tuned without code changes.

**Default template:**
```
[SLACK WRAPPER — READ BEFORE PROCEEDING]

You are running inside a Slack-connected environment. A user sent you this
task via Slack. Your terminal output is recorded to a local log file, but
it is NOT automatically sent to the user.

You have a notification capability. To send a message to the user in Slack,
wrap it in envelope markers. The opening marker is three less-than signs,
the word SLACK, three greater-than signs. The closing marker is three
less-than signs, the word END_SLACK, three greater-than signs. You may
optionally add a type after SLACK, separated by a colon.

Available types: progress, question, warning, done, error.

Rules for when to use envelopes:
  - USE for: completion summaries, questions that need user input,
    warnings, key status updates, anything the user needs to act on.
  - DO NOT USE for: file contents, code diffs, test output, intermediate
    steps, debug information, or anything that is routine.

The user can retrieve the full log at any time by typing /logs in Slack.

[END SLACK WRAPPER]

```

Note: the prompt deliberately describes the markers **in words** rather than
showing literal `<<<SLACK>>>` examples. This prevents the PTY echo of the
prompt itself from containing valid open+close marker pairs that the parser
could misinterpret. The LLM is capable enough to reconstruct the syntax from
the verbal description. (See 8.4 on activation delay for the belt-and-
suspenders backup.)

### 8.6 On-Demand Log Retrieval

The `/logs` command gives the user access to the full session output.

| Command | Behavior |
|---------|----------|
| `/logs` | Uploads the log file from the most recent session as a Slack file attachment |
| `/logs <sessionId>` | Uploads the log for a specific session |
| `/logs tail 50` | Posts the last 50 lines of the most recent log as a code block (no file upload) |
| `/logs list` | Lists all sessions from the last 24 hours with their IDs, status, and duration |

File upload uses Slack's `files.completeUploadToChannel` API. Log files
larger than 20MB are split or truncated with a notice.

### 8.7 Full Output Streamer (shell / cron sessions)

For one-shot and scheduled commands, there is no LLM to instruct.
All output is forwarded to Slack using the buffered update loop:

1. Post an initial message: `⏳ Running...`
2. Accumulate output in a buffer.
3. Every 2 seconds, call `chat.update` with the latest buffer content
   wrapped in a code block.
4. On process exit, do one final update with the complete output and a
   ✅ or ❌ status indicator.

Long output splitting: if the buffer exceeds 3,500 characters, post a
new message and start a new buffer.

### 8.8 ANSI Escape Code Stripping

Applied to all text before it is sent to Slack (both enveloped messages
and full output stream). Not applied to log files — those preserve the
raw terminal output.

```js
function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[mGKHF]|\x1B\[\?[0-9;]*[hl]|\r/g, '');
}
```

Use a well-tested library like `strip-ansi` (from the `chalk` ecosystem) in
production.

---

## 9. Scheduling & Outbound Triggers

### 9.1 Job Definition Format

Jobs are defined in a YAML config file:

```yaml
# jobs.yaml
jobs:
  - name: "daily-backup-check"
    cron: "0 6 * * *"                 # 6:00 AM daily
    command: "bash scripts/backup-check.sh"
    channel: "C0123ABCD"              # target channel ID
    cwd: "/path/to/project"

  - name: "hourly-deploy-status"
    cron: "0 * * * *"                 # every hour
    command: "docker ps --format '{{.Names}} {{.Status}}'"
    channel: "C0123ABCD"
    label: "Deploy Status"            # appears in the Slack message header
```

### 9.2 Scheduler Behavior

On startup:
1. Load `jobs.yaml`.
2. For each job, register a `node-cron` schedule.
3. When a job fires:
   - Post a message to the target channel: `🕐 Scheduled job: <name> starting...`
   - Spawn the command via the CLI Runner (one-shot mode).
   - Output streams back to that channel thread via the Output Streamer.

### 9.3 Ad-Hoc Outbound Triggers

Beyond cron, the system can be extended to listen for other local events:
- A file watcher (`chokidar`) that triggers a build on file change.
- A local HTTP endpoint that other scripts can POST to, triggering a CLI run
  and reporting to Slack.

These are extensions — not in the initial scope — but the architecture
(Command Router → CLI Runner → Output Streamer) supports them without
structural changes.

---

## 10. Command Language & Parsing

### 10.1 Trigger Prefixes

Messages are only acted upon if they match a recognized prefix. This prevents
the bot from accidentally executing arbitrary chat messages.

| Prefix example | Action |
|----------------|--------|
| `claude: <text>` | Start a Claude Code session, send `<text>` as input |
| `kimi: <text>` | Start a Kimi Code session |
| `run: <command>` | Execute a one-shot shell command |
| `/status` | List active sessions |
| `/stop <session>` | Kill a session |
| `/jobs` | List scheduled jobs |
| `/logs` | Upload the full log of the most recent session |
| `/logs <id>` | Upload the log for a specific session |
| `/logs tail 50` | Post the last 50 lines of the most recent log inline |
| `/logs list` | List recent sessions with IDs and status |
| `/help` | Show available commands |

The prefix list and the mapping to CLI binaries are fully configurable.

### 10.2 In-Thread Follow-Up

If a user replies in a thread that has an active session, the message text
is written directly to that session's PTY stdin. No prefix needed — context
is determined by the thread.

### 10.3 Example Flow — LLM Session (envelope-filtered)

```
[User]  claude: write unit tests for utils.js
[Bot]   🚀 Session started — claude code (log: session_abc123)
        [Claude Code is reading files, writing tests, running them.
         All of that output goes to the log file only.]
[Bot]   🤔 I can cover the happy path and null-input cases. Do you
        also want edge cases for malformed input?

[User replies in thread]  yes, add those too

        [Claude Code receives "yes, add those too" as stdin.
         Continues working. Output goes to log only.]
[Bot]   ✅ Done. Added 14 tests in utils.test.js — all pass.
        Coverage: 94% on utils.js.
[Bot]   ✅ Session complete (exit code 0)
```

```
[User]  /logs
[Bot]   📎 session_abc123.log (uploaded — 2.1 KB)
        Contains all 340 lines of terminal output from this session.
```

### 10.4 Example Flow — Shell Command (full output)

```
[User]  run: docker ps --format "table {{.Names}}\t{{.Status}}"
[Bot]   🚀 Session started (shell)
[Bot]   web-server      Up 3 hours
        db-postgres     Up 3 hours
        redis-cache     Up 45 minutes
[Bot]   ✅ Session complete (exit code 0)
```

---

## 11. Security Model

### 11.1 Threat Model

The system has significant power: it can execute arbitrary commands on the
local machine. The attack surface is any Slack message that reaches the bot.
Compromised Slack accounts or injected messages could trigger destructive
commands.

### 11.2 Controls

| Control | Mechanism |
|---------|-----------|
| **Request authenticity** | Socket Mode + Bolt's built-in verification. Only events pushed by Slack over the authenticated WebSocket are processed. |
| **User authorization** | Maintain an allowlist of Slack user IDs that can trigger commands. All others get a "not authorized" response. |
| **Channel restriction** | Only listen for commands in explicitly configured channel IDs. |
| **Command allowlist** | (Optional, strict mode) Only permit commands that match a whitelist pattern. Useful if you don't want full shell access. |
| **Command blocklist** | Block dangerous commands: `rm -rf`, `format`, `shutdown`, etc. Applied as a regex filter before spawn. |
| **Secrets** | All tokens in `.env`. Never in source code, never in Slack messages. |
| **Audit log** | Every command that is executed is logged locally with: timestamp, Slack user ID, command text, exit code. |
| **Timeout** | All sessions have a maximum lifetime. Prevents runaway processes. |

### 11.3 Recommended Threat-Specific Mitigations

- **Prompt injection via Slack messages:** If a malicious user can post to the
  channel, they could try to get Claude Code to execute harmful code. Mitigate
  by: strict user allowlists, separating the "command input" from the
  "CLI working directory" (don't run as root), and reviewing Claude's own
  safety guardrails.
- **Token leakage:** Never echo `process.env` to Slack. Never log env vars.

---

## 12. Rate Limiting & Resilience

### 12.1 Slack Rate Limits

Slack enforces rate limits per API method. The most common limit is
**~1 request/second** with burst tolerance. Exceeding it returns HTTP 429
with a `Retry-After` header.

### 12.2 How This System Stays Within Limits

- **Output buffering:** The 2-second flush interval for `chat.update` means
  at most 0.5 updates/second per session. Even with 3 concurrent sessions,
  this stays under the limit.
- **Streaming API:** The `chat.appendStream` method is specifically designed
  for high-frequency updates. Slack's SDK handles internal buffering.
- **Retry logic:** Bolt and the Web API client handle 429 retries automatically.
  The system does not need to implement this manually.

### 12.3 Resilience

| Failure | Behavior |
|---------|----------|
| Slack WebSocket disconnects | Bolt reconnects automatically with exponential backoff |
| CLI process crashes | `exit` event fires → session is cleaned up → error message posted to thread |
| Node process crashes | Sessions are lost. On restart, the listener reconnects. Cron jobs resume. Post a "wrapper restarted" message on startup. |
| Slack API call fails (non-429) | Log the error. The output buffer is not lost — retry on next flush cycle. |

---

## 13. Project Structure

```
slack-cli-wrapper/
├── .env                          # secrets (gitignored)
├── .env.example                  # template with all required vars
├── .gitignore
├── package.json
├── tsconfig.json                 # if using TypeScript (recommended)
│
├── config/
│   ├── jobs.yaml                 # scheduled job definitions
│   ├── commands.yaml             # CLI prefix → binary mapping
│   └── authorization.yaml        # allowed users, channels
│
├── prompts/
│   └── envelope-instructions.txt # system prompt injected into LLM sessions
│                                  # (edit this to tune LLM notification behavior)
│
├── src/
│   ├── index.ts                  # entry point: loads config, starts everything
│   │
│   ├── slack/
│   │   ├── app.ts                # Bolt app initialization (Socket Mode config)
│   │   ├── listener.ts           # message event handler, ack(), routing
│   │   └── reporter.ts           # chat.postMessage, chat.update, file upload
│   │
│   ├── cli/
│   │   ├── runner.ts             # PTY spawn, session lifecycle, stdin injection
│   │   └── session.ts            # Session class: holds PTY ref, metadata, mode
│   │
│   ├── streaming/
│   │   ├── router.ts             # per-session: route output to envelope or full stream
│   │   ├── envelopeParser.ts     # state machine: scans for <<<SLACK>>> markers
│   │   ├── fullStreamer.ts       # buffered chat.update loop for shell commands
│   │   ├── logWriter.ts          # writes raw PTY output to session log files
│   │   └── ansiStrip.ts          # ANSI escape code removal
│   │
│   ├── scheduler/
│   │   └── scheduler.ts          # loads jobs.yaml, registers node-cron jobs
│   │
│   ├── commands/
│   │   ├── parser.ts             # extracts command + args from message text
│   │   ├── router.ts             # decision tree: who handles this message?
│   │   └── logs.ts               # handles /logs, /logs list, /logs tail N
│   │
│   ├── security/
│   │   ├── authorizer.ts         # checks user ID + channel ID against allowlists
│   │   └── commandFilter.ts      # blocklist regex matching
│   │
│   └── utils/
│       ├── logger.ts             # structured logging (file + console)
│       └── config.ts             # loads and validates env vars + yaml files
│
├── logs/
│   ├── audit.log                 # append-only command execution log
│   └── sessions/                 # one .log file per session (auto-cleaned after 30d)
│       └── session_<id>.log
│
└── README.md
```

---

## 14. Environment & Configuration

### 14.1 `.env` Variables

```bash
# === SLACK ===
SLACK_APP_TOKEN=xapp-...            # Socket Mode connection token
SLACK_BOT_TOKEN=xoxb-...            # Web API / posting token

# === CHANNELS ===
# Comma-separated list of channel IDs the bot listens in
SLACK_LISTEN_CHANNELS=C0123ABCD,C9876ZYXW

# === AUTHORIZATION ===
# Comma-separated list of Slack user IDs allowed to run commands
# Find user IDs via: curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
#   https://slack.com/api/users.list | jq '.members[] | {id, name}'
ALLOWED_USER_IDS=U0123AAA,U0123BBB

# === CLI BINARIES ===
# Paths to CLI executables (or just the command name if on PATH)
CLI_CLAUDE=claude
CLI_KIMI=kimi

# === BEHAVIOR ===
SESSION_TIMEOUT_MINUTES=30          # kill sessions after this long
OUTPUT_FLUSH_INTERVAL_MS=2000       # how often to push buffered output to Slack (shell mode)
OUTPUT_MAX_CHARS_PER_MESSAGE=3500   # split output if longer than this

# === ENVELOPE (LLM-directed notifications) ===
ENVELOPE_PROMPT_FILE=prompts/envelope-instructions.txt  # path to injected system prompt
ENVELOPE_ACTIVATION_DELAY_MS=1500   # ms after prompt write before parser starts scanning
ENVELOPE_UNCLOSED_TIMEOUT_MS=30000  # flush partial envelope if close tag not seen in this long

# === LOGGING ===
LOG_LEVEL=info                      # debug | info | warn | error
LOG_SESSION_RETENTION_DAYS=30       # auto-delete session logs older than this
```

### 14.2 `config/commands.yaml`

```yaml
# Maps message prefixes to CLI configurations
commands:
  - prefix: "claude"
    binary: "${CLI_CLAUDE}"
    mode: interactive              # keeps session alive for follow-up input
    envelope: true                 # inject system prompt, use envelope filtering
    description: "Run Claude Code"

  - prefix: "kimi"
    binary: "${CLI_KIMI}"
    mode: interactive
    envelope: true                 # inject system prompt, use envelope filtering
    description: "Run Kimi Code"

  - prefix: "run"
    binary: "bash"
    args: ["-c"]                   # the command text becomes the argument
    mode: one-shot                 # session ends when process exits
    envelope: false                # no LLM → forward full output
    description: "Run a shell command"
```

### 14.3 `config/authorization.yaml`

```yaml
# Strict authorization rules
rules:
  - channels: ["C0123ABCD"]       # which channels
    users: ["*"]                   # * = any user in ALLOWED_USER_IDS
    allowed_prefixes: ["claude", "kimi", "run"]

  - channels: ["C9876ZYXW"]       # a more restricted channel
    users: ["U0123AAA"]            # only this specific user
    allowed_prefixes: ["run"]      # and only shell commands, not AI CLIs
```

---

## 15. Implementation Roadmap

### Phase 1 — Skeleton & Slack Connection

- [ ] Set up the Node.js project with TypeScript, Bolt, dotenv.
- [ ] Create the Slack app in the Slack API dashboard.
- [ ] Implement `app.ts` with Socket Mode.
- [ ] Verify the bot connects and can receive a message event.
- [ ] Post a simple "hello, I'm alive" message on startup.

### Phase 2 — One-Shot Shell Commands (full output path)

- [ ] Implement the Command Parser and Router.
- [ ] Implement the CLI Runner using `node-pty`.
- [ ] Implement the Log Writer (all output to session log file).
- [ ] Implement the Full Output Streamer (`chat.update` loop).
- [ ] Wire up a `run: <command>` flow end-to-end.
- [ ] Test with simple commands: `echo hello`, `date`, `ls`.
- [ ] Verify log file is written correctly.

### Phase 3 — Interactive Sessions & Envelope System

- [ ] Implement the Session Manager (concurrent session tracking).
- [ ] Implement in-thread stdin injection.
- [ ] Write the envelope system prompt template (`prompts/envelope-instructions.txt`).
- [ ] Implement the Envelope Parser (state machine, split-chunk handling,
  activation delay, unclosed-tag timeout).
- [ ] Implement the Output Router (branches on `envelope: true/false`).
- [ ] Wire up a `claude:` session end-to-end: verify that only enveloped
  messages appear in Slack, and the full output is in the log.
- [ ] Test with multiple envelope types (progress, question, done).
- [ ] Test the unclosed-envelope timeout path.
- [ ] Implement session timeout and `/stop` command.

### Phase 4 — On-Demand Log Retrieval

- [ ] Implement `/logs`, `/logs <id>`, `/logs tail N`, `/logs list`.
- [ ] Implement file upload via `files.completeUploadToChannel`.
- [ ] Test log retrieval for both LLM and shell sessions.
- [ ] Implement log rotation / cleanup (retention policy).

### Phase 5 — Scheduling

- [ ] Implement the Scheduler: load `jobs.yaml`, register cron jobs.
- [ ] Test a simple scheduled job end-to-end (uses full output path).
- [ ] Implement `/jobs` status command.

### Phase 6 — Security & Hardening

- [ ] Implement the Authorizer and CommandFilter.
- [ ] Add the audit log.
- [ ] Test unauthorized access attempts.
- [ ] Add startup validation (fail fast if tokens are missing).

### Phase 7 — Polish & Edge Cases

- [ ] Implement `/help` and `/status` commands.
- [ ] Add a "wrapper restarted" notification on startup.
- [ ] Add a process-level error handler to prevent unhandled crashes.
- [ ] Write a README with setup instructions.
- [ ] Test edge cases: very long output, binary output, process that hangs,
  concurrent sessions, envelope markers split at exact chunk boundaries,
  LLM that never uses envelopes (session produces no Slack output —
  verify completion message still fires).

---

## 16. Key Trade-offs & Decisions

### 16.1 Socket Mode vs HTTP

**Decision: Socket Mode.**

Socket Mode means no public URL, no reverse proxy, no firewall changes. The
system is designed to run on a developer's machine or a private server. HTTP
mode is only needed if you want to publish to the Slack Marketplace (not a
goal here).

### 16.2 node-pty vs child_process.spawn

**Decision: node-pty.**

This is non-negotiable for interactive CLIs like Claude Code. The trade-off is
that `node-pty` requires native compilation (it wraps OS-level `forkpty`). On
Windows it requires `node-gyp` and Visual Studio build tools. On Linux/macOS
it compiles cleanly. If native compilation is a blocker, the fallback is
`child_process.spawn` with `stdio: 'pipe'`, but you will lose interactivity
and TTY-dependent features.

### 16.3 Slack Streaming API — Deferred

**Decision: Not used in the initial design. Revisit if needed.**

The Slack Streaming API (`chat.startStream` etc.) was originally considered
as the primary path for LLM output. With the envelope system in place, this
is no longer necessary. Enveloped messages are discrete, not continuous — they
are posted as individual `chat.postMessage` calls when the parser emits them.
The full output streamer (shell commands) uses `chat.update`, which is
battle-tested and sufficient.

The Streaming API remains an option if a future mode needs truly continuous
text flow to Slack (e.g. a "verbose mode" that streams everything). It is not
needed for the current architecture.

### 16.4 Single Process vs Microservices

**Decision: Single Node.js process.**

The system runs on a developer's machine. Splitting into microservices adds
complexity with zero benefit. Everything is in one process: the Slack listener,
the CLI runners, the scheduler. If the process dies, everything restarts
together.

### 16.5 TypeScript vs JavaScript

**Decision: TypeScript (recommended).**

The system involves complex types: sessions with multiple states, Slack API
payloads, PTY handles. TypeScript catches bugs at compile time and makes the
codebase navigable. The overhead of the build step is minimal for a single-
process local tool.

### 16.6 Envelope Filtering vs Streaming Everything

**Decision: Envelope filtering for LLM sessions. Full streaming for shell.**

This is the most consequential architectural choice in the system. Two
alternatives were considered:

**Option A: Stream everything to Slack.** Simple to implement. The user sees
all output in real time. Downsides: noisy (a typical Claude Code session
produces hundreds of lines the user does not need to read), eats Slack rate
limits fast with concurrent sessions, and makes the channel unusable as a
conversation space.

**Option B: LLM-directed envelope filtering (chosen).** The LLM is already
reading and understanding its own output. It is better positioned than any
heuristic to decide what the user needs to see. We give it the mechanism
(envelope markers) and the instructions (the system prompt). Downsides: the
LLM might forget to use envelopes, or use them too sparingly. Mitigations:
the session always posts a start and end notification, the `/logs` command
is always available, and the system prompt can be tuned. The risk of "too
little in Slack" is much lower severity than the risk of "Slack is unusable
because of noise."

**Why not a regex/heuristic filter instead of LLM-directed?** A regex filter
would try to detect "interesting" lines (errors, warnings, summaries) from
raw output. This is brittle — it breaks when the CLI changes output format,
misses context-dependent importance, and requires constant maintenance. The
LLM already understands semantics. Delegating the decision to it is both
more accurate and zero-maintenance.

### 16.7 Verbal Prompt vs Literal Marker Examples

**Decision: Describe markers in words in the system prompt, not as literal
code examples.**

The system prompt (Section 8.5) describes the envelope markers verbally
("three less-than signs, the word SLACK, three greater-than signs") rather
than showing a literal `<<<SLACK>>>...<<<END_SLACK>>>` block. This is
deliberate: the PTY echoes whatever is written to stdin. If the prompt
contained literal open+close marker pairs, that echo would appear in the
output stream and could be misinterpreted by the parser as a real envelope.

The verbal description adds a small amount of cognitive load for the LLM,
but modern LLMs handle this pattern reliably. The activation delay (Section 8.4)
is a second layer of defense. Both are needed — neither alone is sufficient.

---

*Document version: 1.1 — February 2026*
*Added: envelope protocol, LLM-directed notification filtering, on-demand
log retrieval, two-track output model.*
