# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- File organization improvements following industry best practices
- `.editorconfig` for consistent code style
- `.nvmrc` to specify Node.js version
- `CONTRIBUTING.md` with contribution guidelines
- `.github/` directory with issue templates and PR template
- GitHub Actions CI workflow
- `CHANGELOG.md` to track version history
- Documentation reorganization into `docs/` subdirectories

### Changed

- Moved documentation files from root to `docs/` directory
  - `SETUP_GUIDE.md` → `docs/guides/SETUP.md`
  - `PROCESS_MANAGEMENT.md` → `docs/guides/PROCESS_MANAGEMENT.md`
  - `CLAUDE.md` → `docs/development/CLAUDE.md`

## [1.0.0] - 2026-02-07

### Added

- Initial release of Slack CLI Wrapper
- Slack integration via Bolt framework with Socket Mode
- CLI execution using node-pty for TTY support
- Two-track output model: full logging + Slack filtering
- Envelope protocol for LLM-directed Slack notifications
- Command routing with configurable prefixes
- Session lifecycle management
- Scheduled jobs support with cron expressions
- Authorization and security controls
- Comprehensive test suite (unit, integration, E2E)
- Debug scripts for development

### Features

- **Commands**: `run:` (shell), `claude:` (Claude Code), `kimi:` (Kimi Code)
- **Control commands**: `/status`, `/stop`, `/logs`, `/help`
- **Session logging**: All output written to `logs/sessions/`
- **Thread-based sessions**: Reply in thread for follow-up input
- **Envelope filtering**: LLMs control what gets posted to Slack

[Unreleased]: https://github.com/username/slack-cli-wrapper/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/username/slack-cli-wrapper/releases/tag/v1.0.0
