# Slack LLM Runner 🤖

> Run CLI tools (Claude Code, Kimi, shell commands) from Slack with smart output filtering and full session logging.

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## ✨ What It Does

**Slack CLI Wrapper** is a bidirectional bridge between Slack and CLI tools running on your local machine. It lets you:

- 🚀 **Execute commands** from Slack: `run: docker ps`, `claude: refactor auth.js`, `kimi: explain this code`
- 💬 **Interact with AI CLIs** - Have full conversations with Claude Code or Kimi through Slack threads
- 📊 **Run scheduled jobs** - Cron jobs that execute commands and report to Slack
- 📁 **Access full logs** - Complete session output is always logged locally, retrievable on demand
- 🧠 **Smart filtering** - AI CLIs use "envelope" markers to decide what gets posted to Slack (no noise!)

### Demo

```
[Slack #dev-channel]

Alice:  claude: write tests for utils.js

Bot:    🚀 Session started (claude code) — logs: session_abc123.log

        [Claude reads files, writes tests, runs them — 
         ~200 lines of output goes to log file only]

Bot:    ✅ Refactor complete. All 47 tests pass.
        Coverage: 94% on utils.js.

Bot:    ✅ Session complete (exit code 0)

Alice:  /logs
Bot:    📎 session_abc123.log (2.1 KB uploaded)
```

## 🏗️ Architecture Overview

```
┌─────────────┐     WebSocket      ┌─────────────────────────────────────────────┐
│   Slack     │◀══════════════════▶│  Slack CLI Wrapper (Node.js)               │
│  (Cloud)    │    (Socket Mode)   │                                             │
└─────────────┘                    │  ┌─────────────┐    ┌───────────────────┐  │
                                   │  │   Slack     │    │   CLI Runner      │  │
                                   │  │  Listener   │───▶│   (node-pty)      │  │
                                   │  │  (Bolt)     │◀───│                   │  │
                                   │  └─────────────┘    └─────────┬─────────┘  │
                                   │                               │            │
                                   │                    ┌──────────┴─────────┐   │
                                   │                    ▼                    ▼   │
                                   │           ┌─────────────┐      ┌──────────┐ │
                                   │           │  Envelope   │      │  Full    │ │
                                   │           │  Parser     │      │ Output   │ │
                                   │           │  (LLM mode) │      │ Streamer │ │
                                   │           └──────┬──────┘      └────┬─────┘ │
                                   │                  │                   │      │
                                   │         ┌────────▼────────┐  ┌───────▼────┐ │
                                   │         │     Slack       │  │   Slack    │ │
                                   │         │   (enveloped)   │  │  (all out) │ │
                                   │         └─────────────────┘  └────────────┘ │
                                   └─────────────────────────────────────────────┘
```

**Two-Track Output Model:**
- **Track 1: Log** → Everything is written to `logs/sessions/<sessionId>.log`
- **Track 2: Slack** → AI CLIs use envelope markers; shell commands stream everything

## 🚀 Quick Start

### Prerequisites

- Node.js 20+ 
- A Slack workspace where you can create apps
- Bash shell (Windows: Git Bash or WSL)
- (Optional) `claude` CLI or `kimi` CLI for AI features

### 1. Clone & Install

```bash
git clone https://github.com/yourusername/slack-cli-wrapper.git
cd slack-cli-wrapper
npm install
```

### 2. Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App**
2. Enable **Socket Mode** (toggle ON)
3. Generate an **App-Level Token** with scope `connections:write`
4. Add **Bot Token Scopes**: `chat:write`, `channels:read`, `users:read`
5. Subscribe to **Bot Events**: `message.channels`
6. **Install to Workspace**

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:
```bash
SLACK_APP_TOKEN=xapp-...            # From step 2
SLACK_BOT_TOKEN=xoxb-...            # From step 2
SLACK_LISTEN_CHANNELS=C0123456789   # Channel ID(s) to listen in
ALLOWED_USER_IDS=U0123456789        # Your Slack user ID
```

### 4. Configure Commands

Edit `config/commands.yaml`:
```yaml
commands:
  - prefix: "run"
    binary: "bash"
    args: ["-c"]
    mode: one-shot
    envelope: false
    description: "Run a shell command"

  - prefix: "claude"
    binary: "claude"          # or full path
    args: ["--verbose"]
    promptFlag: "-p"
    sessionIdFlag: "--session-id"  # Create new session
    resumeFlag: "--resume"         # Continue existing session
    mode: one-shot
    envelope: true
    description: "Run Claude Code"
```

### 5. Run

```bash
npm run dev        # Development with hot reload
# or
npm run build      # Build for production
npm start          # Run production build
```

## 🐳 Docker

Running in Docker is recommended for production deployments (e.g., on Hetzner or other Linux servers).

### Quick Start with Docker

```bash
# 1. Copy the environment template
cp .env.example .env

# 2. Edit .env with your Slack and API tokens
# Required variables:
#   - SLACK_APP_TOKEN
#   - SLACK_BOT_TOKEN
#   - SLACK_LISTEN_CHANNELS
#   - ALLOWED_USER_IDS
#   - CLAUDE_CODE_OAUTH_TOKEN (for Claude commands)
#   - ANTHROPIC_API_KEY (for Claude API access)
nano .env

# 3. Build and run
docker compose up -d --build

# 4. View logs
docker compose logs -f slack-llm-runner
```

### Docker Image Structure

The Docker image uses a multi-stage build:
- **Builder stage** (`node:22-bookworm`): Compiles native modules (`node-pty`, `better-sqlite3`) and TypeScript
- **Runtime stage** (`node:22-bookworm-slim`): Lean production image with compiled binaries only

### Volumes

The Docker setup uses three bind-mounted volumes for persistent data:

| Volume | Purpose |
|--------|---------|
| `./config` | Configuration files (YAML, prompts) — edits sync without rebuild |
| `./data` | Application data and databases |
| `./logs` | Session logs and audit trails |

### Environment Variables in Docker

See `.env.example` for all available options. Key variables for Docker:

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_APP_TOKEN` | Yes | Socket Mode token (`xapp-...`) |
| `SLACK_BOT_TOKEN` | Yes | Web API token (`xoxb-...`) |
| `SLACK_LISTEN_CHANNELS` | Yes | Channel IDs to monitor |
| `ALLOWED_USER_IDS` | Yes | Slack user IDs allowed to run commands |
| `CLAUDE_CODE_OAUTH_TOKEN` | Optional | For Claude Code CLI integration |
| `ANTHROPIC_API_KEY` | Optional | For direct Anthropic API calls |

### Useful Docker Commands

```bash
# Rebuild image after code changes
docker compose build

# View real-time logs
docker compose logs -f

# Stop containers
docker compose down

# Restart service
docker compose restart slack-llm-runner

# Shell into running container (debugging)
docker compose exec slack-llm-runner bash

# Remove volumes (careful: deletes data/logs/config!)
docker compose down -v
```

### Note: Windows Development

Windows developers should continue running natively with `npm run dev` (not Docker). The Docker setup targets Linux production environments only.

## 💬 Usage

### Shell Commands (Full Output)

```
run: docker ps
run: npm test
run: ls -la
```

Output streams directly to Slack in real-time.

### AI CLI Sessions (Envelope Filtered)

```
claude: refactor the auth module
kimi: explain this regex
```

The AI sees a system prompt that teaches it to use envelope markers:

```
<<<SLACK:progress>>>
Analyzed auth module. Found 3 functions to refactor.
<<<END_SLACK>>>
```

Only enveloped messages appear in Slack. Full output is in the log.

### Thread Follow-Ups & Session Continuation

Reply in the thread to continue the conversation with context preserved:

```
Alice: claude: my name is Alice
Bot:   🚀 Session started — Run Claude Code
       ✅ Session complete (exit code 0)

Alice [in thread]: what is my name?
      → Spawns continuation with --resume, Claude remembers "Alice"
```

**How it works:**
- **Kimi**: Uses `-S <session-id>` flag (same for create and resume)
- **Claude**: Uses `--session-id <uuid>` for first call, `--resume <uuid>` for follow-ups
- **Session IDs**: Deterministically generated from `slack-<channel>-<thread>` so same thread always maps to same session

### Control Commands

| Command | Description |
|---------|-------------|
| `/status` | List active sessions |
| `/stop <id>` | Kill a session |
| `/logs` | Upload most recent session log |
| `/logs <id>` | Upload specific session log |
| `/logs tail 50` | Show last 50 lines |
| `/logs list` | List recent sessions |
| `/help` | Show available commands |

## ⚙️ Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `SLACK_APP_TOKEN` | Socket Mode connection token (`xapp-...`) |
| `SLACK_BOT_TOKEN` | Web API token (`xoxb-...`) |
| `SLACK_LISTEN_CHANNELS` | Comma-separated channel IDs |
| `ALLOWED_USER_IDS` | Comma-separated user IDs allowed to run commands |
| `SESSION_TIMEOUT_MINUTES` | Max session lifetime (default: 30) |
| `OUTPUT_FLUSH_INTERVAL_MS` | How often to push output (default: 2000) |
| `ENVELOPE_ACTIVATION_DELAY_MS` | Delay before parsing envelopes (default: 1500) |

### Authorization (`config/authorization.yaml`)

```yaml
rules:
  - channels: ["C0123456789"]
    users: ["*"]                    # Any user in ALLOWED_USER_IDS
    allowed_prefixes: ["claude", "kimi", "run"]

  - channels: ["C9876543210"]
    users: ["U0123456789"]          # Only specific user
    allowed_prefixes: ["run"]       # Only shell commands
```

### Scheduled Jobs (`config/jobs.yaml`)

```yaml
jobs:
  - name: "daily-backup-check"
    cron: "0 6 * * *"
    command: "bash scripts/backup-check.sh"
    channel: "C0123456789"
    cwd: "/path/to/project"
```

## ✉️ Mail Triage Agent (built, not yet live)

An optional email-triage capability layered on top of the runner: a scheduled job runs Claude Code restricted to a read-only `mailctl` CLI, which proposes actions (archive/move/flag/reply/delete) into a local SQLite queue. A human approves or rejects each one via Slack buttons; only an approval invokes a separate deterministic executor, which is the sole code path that ever writes to the mail server, via [Himalaya](https://github.com/pimalaya/himalaya). Claude never picks a recipient and never executes a write directly — see [`docs/development/CLAUDE.md`](docs/development/CLAUDE.md#mail-triage-agent) for the full design and enforcement principle.

**Status:** all the code is written and unit/integration-tested (`src/mail/`, `bin/mailctl`), but it is **not wired into a running instance** — no session has connected it end-to-end against a real mailbox yet. To go live:

1. Install [Himalaya](https://github.com/pimalaya/himalaya) (v2.1.0) and create `~/.config/himalaya/config.toml` with a real account — an app-password-based Gmail IMAP/SMTP entry for v1 (native Gmail OAuth isn't supported by Himalaya v2). See `docs/development/CLAUDE.md`'s Mail Triage Agent section for the config shape.
2. Fill in `config/mail.yaml` (`imapAccount`, `digestChannel`, `dbPath`) — it currently exists only as a placeholder and is not yet read by `loadConfig()`.
3. Wire `src/index.ts` to construct a `MailStore` and pass `mailStore`/`mailDbPath` into `registerListeners()` (`src/slack/listener.ts`) — without this, the `mail_approve`/`mail_reject` buttons never register.
4. Wire an `onJsonResult` callback into the `SessionManager` constructor (`src/cli/runner.ts`) that renders the mail-triage job's captured JSON via `src/mail/digestRenderer.ts` and posts it with `SlackReporter.postBlocks()` — without this, the cron job runs but nothing ever reaches Slack.
5. Uncomment the `morning-mail-triage` job in `config/jobs.yaml` and set a real `channel`.
6. Test the full loop against a real (ideally disposable/test) mailbox before trusting it with a real inbox.

## 🔧 Development

### Project Structure

```
slack-cli-wrapper/
├── src/
│   ├── cli/              # PTY spawn, session lifecycle
│   ├── commands/         # Command parsing & routing
│   ├── streaming/        # Envelope parser, streamer, log writer
│   ├── scheduler/        # Cron job scheduling
│   ├── security/         # Authorization & command filtering
│   ├── slack/            # Bolt app, listeners, reporter
│   ├── mail/             # Mail-triage agent (mailctl, executor, SQLite store, digest renderer)
│   └── utils/            # Config, logger, formatting
├── bin/
│   └── mailctl(.cmd)     # Shim so --allowedTools can match a literal `mailctl` on PATH
├── config/
│   ├── prompts/          # System prompts for LLMs
│   ├── schemas/          # JSON Schemas for structured CLI output (e.g. mail digest)
│   ├── authorization.yaml
│   ├── commands.yaml
│   ├── jobs.yaml
│   └── mail.yaml         # Mail-triage config (not yet loaded — see Mail Triage Agent section)
├── scripts/debug/        # Manual debugging utilities
└── test/                 # Automated tests
```

### Scripts

```bash
npm run dev              # Development mode
npm run build            # Compile TypeScript
npm start                # Production mode
npm test                 # Run unit tests
npm run test:lifecycle   # Run E2E session lifecycle tests
npm run restart          # Kill all node processes and restart
```

### Running Tests

```bash
# Unit tests for process handle
npm test

# E2E tests for session lifecycle
npm run test:lifecycle

# Integration test
node --import tsx --test test/integration.test.ts
```

## 🔒 Security

- **No tokens in code** - All secrets in `.env` (gitignored)
- **User allowlist** - Only configured Slack users can run commands
- **Channel restriction** - Bot only listens in configured channels
- **Command filtering** - Block dangerous patterns (`rm -rf`, etc.)
- **Audit logging** - Every command logged with user ID, timestamp, exit code
- **Session timeouts** - Prevent runaway processes

### Security Best Practices

1. Keep `.env` file secure and never commit it
2. Use specific user IDs in `ALLOWED_USER_IDS`, not `*`
3. Restrict `allowed_prefixes` per channel as needed
4. Review audit logs regularly: `logs/audit.log`
5. Run with minimal permissions (don't run as root)

## 🤝 Contributing

Contributions are welcome! Here's how to get started:

### Development Setup

```bash
# Fork and clone
git clone https://github.com/YOUR_USERNAME/slack-cli-wrapper.git
cd slack-cli-wrapper

# Install dependencies
npm install

# Copy env template
cp .env.example .env
# Edit .env with your test Slack app tokens

# Run in dev mode
npm run dev
```

### Contribution Guidelines

1. **Fork** the repository
2. **Create a branch** for your feature: `git checkout -b feature/amazing-feature`
3. **Make your changes** with clear, focused commits
4. **Add tests** if applicable
5. **Update documentation** if needed
6. **Submit a Pull Request** with a clear description

### Code Style

- TypeScript with strict mode enabled
- Use meaningful variable names
- Add JSDoc comments for public APIs
- Keep functions focused and small
- Handle errors gracefully

### Areas for Contribution

- [ ] Additional CLI integrations
- [ ] Better output formatting
- [ ] Web dashboard for session logs
- [ ] More envelope types
- [ ] Plugin system for custom handlers
- [ ] Windows/WSL improvements
- [ ] Wire the Mail Triage Agent live (see the Go-Live checklist in its own section above)
- [ ] Native Gmail OAuth support for the Mail Triage Agent (Himalaya v2 has no built-in OAuth flow)
- [ ] `send` action kind for the Mail Triage Agent (net-new outbound mail — deliberately deferred, see `docs/development/CLAUDE.md`)

## 📚 Documentation

- [Architecture Guide](docs/slack-cli-wrapper-architecture.md) - Detailed system design
- [Setup Guide](SETUP_GUIDE.md) - Step-by-step setup instructions
- [Process Management](PROCESS_MANAGEMENT.md) - Handling orphaned processes

## 🐛 Troubleshooting

### Bot won't connect

```bash
# Kill all node processes
npm run clean

# Wait 30 seconds for Slack to release connection
# Then restart
npm run dev
```

### No output from commands

- Check that `bash.exe` is in your PATH (Windows)
- Verify session logs: `logs/sessions/*.log`
- Run E2E tests: `npm run test:lifecycle`

### Socket Mode disconnects

Slack only allows one connection per app token. If you have multiple instances running:
1. Kill all node processes: `npm run clean`
2. Wait 30 seconds
3. Restart the bot

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Built with [Slack Bolt](https://slack.dev/bolt-js/concepts) framework
- Uses [node-pty](https://github.com/microsoft/node-pty) for PTY support
- Inspired by the need for less noisy AI CLI integrations

---

<p align="center">
  Made with ❤️ for cleaner Slack integrations
</p>
