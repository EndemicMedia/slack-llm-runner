# Slack CLI Wrapper - Setup & Operation Guide

## ✅ What's Configured

- **Slack App**: DebateBot with Socket Mode enabled
- **Channel**: #wrapper-test (C0ACQMYN1C7)
- **Shell**: Bash (`/usr/bin/bash -c`)
- **Commands**:
  - `run:` - Execute bash commands
  - `claude:` - Run Claude Code (requires `claude` CLI)
  - `kimi:` - Run Kimi Code (requires `kimi` CLI)
- **Authorization**: Any user in the configured channel can run commands

## 🚀 Starting the Bot

```bash
cd d:\Dados\Code\slack-wrapper

# Kill any existing processes
pkill -9 node || taskkill /F /IM node.exe

# Wait 10 seconds for Slack to release old connections
sleep 10

# Start the bot
npm run dev
```

## 📝 Using the Bot

Once connected, send commands in #wrapper-test:

```
run: echo "Hello World"
run: date
run: pwd
run: ls -la /usr/bin
```

The bot will:
1. Post "Session started" message
2. Execute the command
3. Post "Exited with code X" message

## 📊 Monitoring

Check logs in real-time:
```bash
tail -f d:\Dados\Code\slack-wrapper\logs/bot.log
```

View session outputs:
```bash
ls d:\Dados\Code\slack-wrapper\logs/sessions/
cat d:\Dados\Code\slack-wrapper\logs/sessions/session_*.log
```

## ⚠️ Known Issues

### Socket Mode Connection Failures

**Symptom**: Bot connects but immediately shows "server explicit disconnect"

**Causes**:
- Multiple bot instances trying to connect simultaneously
- Slack server holding stale connection from previous instance
- App/Bot tokens may need regeneration

**Solutions**:
1. Ensure ALL Node processes are killed: `pkill -9 node`
2. Wait 30 seconds before restarting
3. If persistent, regenerate tokens:
   - Go to [api.slack.com/apps](https://api.slack.com/apps) → DebateBot
   - Generate new App-Level Token (connections:write)
   - Generate new Bot User OAuth Token
   - Update `.env` file
   - Restart bot

### Command Output Not Captured

**Symptom**: Bot shows "Exited with code 0" but no output in Slack

**Status**: This is a known limitation with node-pty + Windows environment
- Command executes successfully (exit code 0)
- Output is captured in session logs: `logs/sessions/session_*.log`
- Can see output by running: `tail -f logs/sessions/session_*.log`

## 🔧 Configuration Files

- `.env` - Slack tokens and settings
- `config/authorization.yaml` - Channel/user permissions
- `config/commands.yaml` - Command definitions
- `config/jobs.yaml` - Scheduled jobs (cron)

## 📦 Build for Production

```bash
npm run build
npm start
```

This compiles TypeScript to `dist/` and runs the production binary.

## 🆘 Troubleshooting

**Bot won't start:**
```bash
npm run dev 2>&1 | head -50
```

**Check if Node is running:**
```bash
ps aux | grep node
```

**Kill stuck processes:**
```bash
pkill -9 node
pkill -9 npm
pkill -9 tsx
```

**Clear logs:**
```bash
cd d:\Dados\Code\slack-wrapper
rm logs/bot.log
rm logs/sessions/*.log
```
