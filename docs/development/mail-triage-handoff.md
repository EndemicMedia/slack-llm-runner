# Mail Triage Agent — Session Handoff

This document is a full context dump of the work done on branch
`claude/chatgpt-conversation-tradeoffs-76bp5i` (GitHub PR #1), so a
local Claude Code session (or a human) can pick it up without needing
the original conversation.

## How we got here

1. You shared a ChatGPT conversation link discussing how to build a
   personal email-triage agent. ChatGPT's final recommendation, after
   being shown this repo, was: don't build a separate daemon — evolve
   `slack-llm-runner` into the control plane, using Himalaya (a mail
   CLI) for IMAP/SMTP, SQLite for durable state, and Slack for
   approvals, since the hard-to-rebuild parts (Slack↔Claude-session
   mapping, scheduler, auth) already exist here.
2. A security-focused review of that plan, cross-checked against the
   actual source, found the premise sound but flagged real gaps: the
   scheduler bypasses authorization entirely, Claude runs with no tool
   restrictions today, and session state is in-memory only.
3. We turned that into an implementation plan (reviewed by a second
   agent for security holes before starting), then built it stage by
   stage, verifying tests myself before every commit.
4. Once pushed, GitHub Actions created PR #1 automatically. CI failed
   repeatedly; investigating turned up several real, mostly
   pre-existing bugs (not just the obvious dependency issue). All are
   now fixed and **CI is green** as of commit `8d472a5`.

## The core design principle (non-negotiable)

**Claude never picks an email recipient and never executes a write
directly.** It only reads mail via a restricted `mailctl` CLI and
proposes actions into a SQLite queue; a human approves or rejects via
Slack buttons; a separate deterministic `mail-executor` performs the
actual write, deriving the recipient from the stored source message —
never from anything Claude wrote. Enforcement is structural (what
`mailctl` simply doesn't expose as a subcommand) and CLI-flag-based
(`--allowedTools`/`--permission-mode`), never dependent on the model
choosing to comply with prompt text.

## What was implemented (in commit order)

1. **`a63c6bb`, `1560e7e`** — Docker support (multi-stage `Dockerfile`,
   `docker-compose.yml`, `.dockerignore`) and a real security fix:
   `Scheduler.fire()` previously spawned every cron job via a hardcoded
   shell, **bypassing** the `Authorizer`/`checkCommand` checks the
   interactive Slack router always applied. Added `JobDefinition.kind:
   'command'` so a job can route through the same auth/filtering path,
   with a regression test (`test/integration/schedulerCommandJob.test.ts`)
   proving existing shell-kind jobs are untouched.
2. **`ef1b015`, `884e2d6`, `bdbe1e8`** — the read-only mail layer:
   - `src/mail/types.ts` — shared types (`MailEnvelope`, `ActionKind`,
     `ActionParams`, `ProposedAction`, `MailDigest`).
   - `src/mail/himalayaClient.ts` — thin `execFile`-based wrapper
     around the `himalaya` CLI binary (no shell interpolation).
   - `src/mail/threadStore.ts` — `better-sqlite3`-backed `MailStore`:
     `mail_envelopes` and `proposed_actions` tables, WAL mode.
   - `src/mail/mailctl.ts` + `bin/mailctl`/`bin/mailctl.cmd` — the
     restricted CLI. Subcommands: `list`, `search`, `read`, `thread`,
     `context` (all read-only, no `--seen` on reads) and `propose`
     (the only write-shaped subcommand — it only inserts a SQLite row,
     never touches the network). Its argument parser has **no**
     `--to`/`--recipient`/`--cc`/`--bcc` flag anywhere, and rejects any
     unknown flag outright.
3. **`c785363`, `c79424a`, `1c0d4af`** — Claude integration:
   - New optional `CommandConfig` fields (`allowedTools`,
     `disallowedTools`, `permissionMode`, `outputFormat`,
     `jsonSchemaPath`, `maxTurns`, `maxBudgetUsd`), wired into
     `spawnArgs` in `src/cli/runner.ts`.
   - A new "capture mode" in `src/streaming/router.ts` +
     `src/cli/processHandle.ts`: when a job's `outputFormat: 'json'`,
     stdout and stderr are captured separately (not merged, so stderr
     noise can't corrupt the JSON), and the buffered JSON is handed to
     a new optional `onJsonResult` callback on `SessionManager` instead
     of the normal completion banner.
   - `src/mail/digestRenderer.ts` — renders Claude's digest JSON into
     Slack Block Kit, but **reconciles every item against the live
     SQLite row first**: an item only gets Approve/Reject buttons if
     its `proposedActionId` resolves to a still-`pending` row. Anything
     stale, missing, or already decided renders as inert text. This is
     the fix for "Claude's JSON output and the SQLite queue could be
     two different sources of truth."
   - `SlackReporter.postBlocks()`, plus the new `mail-triage`
     `commands.yaml` entry, `config/schemas/mail-digest.schema.json`,
     a commented-out example job in `jobs.yaml`, and a `config/mail.yaml`
     placeholder.
4. **`434217f`, `f904355`** — the executor and approval buttons:
   - `src/mail/executor.ts` — the *only* file that performs a real
     Himalaya write. Given an `action_id`: loads the row, refuses
     unless `status === 'approved'`, loads the source envelope, derives
     the recipient/folder/account purely from that envelope (never
     from `params_json` — `reply`'s `ActionParams` variant has only a
     `body` field, structurally no recipient field exists), and calls
     Himalaya. Closes a real cross-process race (two Slack clicks each
     spawning a separate executor process) via
     `MailStore.claimForExecution()`, an atomic conditional SQL UPDATE
     — verified with two actual concurrent OS processes, not just an
     in-process test.
   - `src/slack/listener.ts` gained `mail_approve`/`mail_reject`
     button handlers. Approve writes `markDecided('approved', ...)`
     **before** invoking the executor subprocess (required ordering).
     Reject writes `markDecided('rejected', ...)` and never touches the
     executor at all.
5. **`8d19d22`, `ed8273d`** — documentation: a "Mail Triage Agent"
   section in `docs/development/CLAUDE.md` (architecture, enforcement
   principle, Himalaya setup) and a **Go-Live Checklist** there, plus a
   matching summary in `README.md`.
6. **`f1ccabf`, `425e6d4`, `8d472a5`** — CI fixes (see below).

## CI investigation — what was actually wrong

PR #1's CI failed on the first push. This took several rounds to fully
fix because it turned out to be five separate, layered problems, not
one:

1. `better-sqlite3@13.0.3` requires Node ≥22 and has no prebuilt binary
   for `windows-latest + Node 20.x`, so `npm ci` fell back to a
   from-source `node-gyp` build that failed (no MSVC on the runner).
   Downgraded to `^12.11.1` — still didn't fully fix it (see #2).
2. That same combo still failed even on the downgraded version — the
   runner's node-gyp genuinely can't detect a usable Visual Studio
   install (`unknown version "undefined"`) on this specific image,
   independent of the npm package. Rather than keep chasing package
   versions, `windows-latest + Node 20.x` was **excluded** from the CI
   matrix (see `.github/workflows/ci.yml`'s `exclude` block) —
   `windows-latest + 22.x` and `ubuntu/macos + 20.x` all pass, so no
   real coverage is lost.
3. **The big one**: `ci.yml`'s `hashFiles('tests/unit/**/*.test.ts')`
   checks pointed at a directory that has never existed — the real
   path is `test/` (singular). Every "Run unit tests"/"Run integration
   tests" step had been silently skipping **since the workflow was
   written**, meaning every test added across this entire PR had never
   actually executed in CI. Fixed the path.
4. Actually enabling those steps surfaced several genuinely
   pre-existing bugs, none introduced by the mail-triage work itself:
   - Two test files (`test/unit/processHandle.test.ts`,
     `test/integration/integration.test.ts`) hardcoded Windows-only
     binaries (`cmd`, `bash.exe`) with no platform guard — fixed to
     pick the right binary per `process.platform`.
   - `test/integration/slack-integration.test.ts` needs
     `SLACK_APP_TOKEN`/`SLACK_BOT_TOKEN`/`SLACK_LISTEN_CHANNELS`/
     `ALLOWED_USER_IDS` to merely be *present* (their value is never
     checked; the test mocks the Slack reporter) — added placeholder
     values to the CI step's env.
   - That same test also exercises `config/commands.yaml`'s real,
     checked-in `run` prefix, which intentionally hardcodes
     `binary: "bash.exe"` as documented Windows-first production
     behavior — correctly **skipped on non-Windows** rather than
     editing production config to satisfy CI.
   - `LogWriter.close()` called `stream.end()` without awaiting the
     actual flush, so a reader right after (this test, and the `/logs`
     command) could race a write stream that hadn't finished. Now
     returns a `Promise` that resolves on flush; `OutputRouter.finish()`
     awaits it.
   - `spawnProcess()`'s dummy-stdin write could hit a fast-exiting
     command (e.g. `echo`) that had already closed stdin, throwing an
     uncaught `EPIPE`. Added a no-op error handler (the write is
     best-effort).
5. One Windows-only flake in the *fix* for #4: swapping `bash -c
   "sleep 30"` in for Windows' native `timeout` broke the kill-promptness
   test, because killing bash.exe doesn't reliably reach the `sleep`
   grandchild it forked. Fixed by using the single-process-friendly
   command per platform for that one test.

**Current state: PR #1's CI is green** (workflow run `33755269229`,
commit `8d472a5`).

## What is NOT done — the feature is built but inert

Every piece above is implemented and unit/integration-tested with
Himalaya calls mocked/stubbed. **Nothing has been tested against a
real mailbox**, and the feature isn't wired into the running app yet.
To actually turn it on, in order:

1. **Install Himalaya v2.1.0** and create a real
   `~/.config/himalaya/config.toml` (or `%APPDATA%\himalaya` on
   Windows) with a real `[accounts.<name>]` block. **Use an app
   password for Gmail IMAP/SMTP** — Himalaya v2 ships no OAuth flow of
   its own, so native Gmail API auth is out of scope for v1. See
   `docs/development/CLAUDE.md`'s "Mail Triage Agent" section for the
   exact config shape and folder-alias requirements.
2. **Fill in and load `config/mail.yaml`.** It currently exists only
   as a placeholder (`imapAccount`, `digestChannel`, `dbPath`) and is
   **not read** by `src/utils/config.ts`'s `loadConfig()` yet — that
   needs extending.
3. **Wire `MailStore` into `src/index.ts`.** Construct it at startup
   and pass it (plus the resolved db path) into
   `registerListeners(app, router, listenChannels, mailStore,
   mailDbPath)` (`src/slack/listener.ts`) — without this, the
   `mail_approve`/`mail_reject` buttons silently never register (no
   error, clicking them just does nothing).
4. **Wire an `onJsonResult` callback into `SessionManager`**
   (`src/cli/runner.ts`'s constructor already accepts one). It needs
   to: parse the mail-triage job's captured JSON as a `MailDigest`,
   call `renderDigestBlocks()` against the same `MailStore` instance,
   and post the result via `SlackReporter.postBlocks()`. Without this,
   the cron job runs Claude and populates `proposed_actions`, but the
   digest never reaches Slack.
5. **Uncomment the `morning-mail-triage` job** in `config/jobs.yaml`
   and set a real Slack `channel` ID matching `mail.yaml`'s
   `digestChannel`.
6. **Test end-to-end against a real (ideally disposable/test)
   mailbox.**

## What to test locally, concretely

Assuming you're on `D:\Dados\Code\slack-llm-runner` on the
`claude/chatgpt-conversation-tradeoffs-76bp5i` branch (after `git
fetch && git checkout claude/chatgpt-conversation-tradeoffs-76bp5i`):

1. **`npm ci` then `npx tsc --noEmit`** — should be clean.
2. **`npm run test:unit`** — should be 90/90 passing (this repo runs on
   Node's built-in test runner, not Jest/Vitest).
3. **`npm run test:integration`** — 8 passing, 1 skipped (the
   Windows-only `slack-integration.test.ts` test — it should **not**
   be skipped on your Windows machine, since it exercises the real
   `bash.exe`-configured `run` prefix; confirm it actually passes there
   rather than just skipping, since that's the one thing this sandbox
   couldn't verify).
4. **Docker**: `docker compose up -d --build` — this sandbox couldn't
   run an actual Docker daemon, so the build was only verified for
   Dockerfile syntax and package-script consistency, not a real build.
   Worth confirming it builds and boots locally.
5. Once you start on the Go-Live steps above: `mailctl list`/`read`/
   `propose` can be run standalone once Himalaya is configured, and
   inspected directly with a SQLite browser against `data/mail.db`, to
   validate the read path before wiring Slack/Claude into it.
6. Full end-to-end (after all Go-Live steps): trigger the cron job
   manually (or temporarily set `cron: "* * * * *"`), confirm the
   digest posts to Slack with buttons only on reconciled
   (still-pending) actions, approve one against a disposable test
   email, confirm it executes and the message updates, reject another
   and confirm no Himalaya call was made.

## Files worth reading first, in priority order

1. `docs/development/CLAUDE.md` — repo conventions + the Mail Triage
   Agent section + Go-Live Checklist (the most authoritative doc).
2. `src/mail/mailctl.ts` and `src/mail/executor.ts` — read their
   top-of-file comments; these two are the security boundary the whole
   feature depends on.
3. `src/mail/threadStore.ts` — the SQLite schema and `MailStore` API.
4. `.github/workflows/ci.yml` — now has an `exclude` block and env vars
   worth understanding if CI ever goes red again.
