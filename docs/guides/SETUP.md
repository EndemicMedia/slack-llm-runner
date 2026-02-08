# Slack LLM Runner - Setup & Operation Guide

## 🛠️ Slack App Setup (Admin Steps)

Follow these steps to create and configure your Slack app:

### Step 1: Create a New Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **"Create New App"**
3. Select **"From scratch"**
4. Enter an **App Name** (e.g., "CLI Runner Bot")
5. Select your **Workspace** from the dropdown
6. Click **"Create App"**

### Step 2: Enable Socket Mode

Socket Mode allows your bot to receive events without exposing a public URL:

1. In the left sidebar, click **"Socket Mode"** under **Settings**
2. Toggle **"Enable Socket Mode"** to ON
3. When prompted, generate an **App-Level Token**:
   - Enter a token name (e.g., "socket-token")
   - Add the scope: `connections:write`
   - Click **"Generate"**
4. **Copy and save this token** (starts with `xapp-`) — you'll need it for your `.env` file

### Step 3: Configure Bot Token Scopes

These permissions define what your bot can do:

1. In the left sidebar, click **"OAuth & Permissions"**
2. Scroll down to **"Scopes"** → **"Bot Token Scopes"**
3. Click **"Add an OAuth Scope"** and add these scopes:
   - `chat:write` — Send messages to channels
   - `channels:read` — View channel information
   - `users:read` — View user information (for authorization)
4. (Optional) If using in private channels, also add:
   - `groups:read` — View private channel information
   - `chat:write.public` — Send messages to channels without joining

### Step 4: Subscribe to Bot Events

Events tell Slack what notifications to send to your bot:

1. In the left sidebar, click **"Event Subscriptions"**
2. Toggle **"Enable Events"** to ON
3. Under **"Subscribe to bot events"**, click **"Add Bot User Event"**
4. Add the event: `message.channels` — Listen for messages in channels
5. Click **"Save Changes"**

### Step 5: Install App to Workspace

1. In the left sidebar, click **"Install App"**
2. Click **"Install to Workspace"**
3. Review the permissions and click **"Allow"**
4. **Copy the "Bot User OAuth Token"** (starts with `xoxb-`) — you'll need it for your `.env` file

### Step 6: Invite Bot to Channel

Your bot must be in the channel to receive messages:

1. In Slack, go to the channel where you want to use the bot
2. Type `/invite @YourBotName` and press Enter
3. The bot should appear in the channel member list

### Step 7: Get Channel and User IDs

You'll need these for your `.env` and authorization config:

**Channel ID:**
1. In Slack, right-click the channel name
2. Select **"View channel details"** or **"Copy"** → **"Copy link"**
3. The ID is the string at the end (e.g., `C0123456789`)
   - From link: `https://app.slack.com/client/.../C0123456789`

**User ID:**
1. Click your profile picture in Slack
2. Click **"Profile"**
3. Click the **three dots** → **"Copy member ID"**
   - Format: `U0123456789`

## ⚙️ Local Configuration

### Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` with your tokens and IDs:

```bash
# From Step 2
SLACK_APP_TOKEN=xapp-xxxxxxxxxx-xxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxx

# From Step 5
SLACK_BOT_TOKEN=xoxb-xxxxxxxxxx-xxxxxxxxxx-xxxxxxxxxxxxxxxx

# From Step 7
SLACK_LISTEN_CHANNELS=C0123456789,C9876543210

# From Step 7 (comma-separated for multiple users)
ALLOWED_USER_IDS=U0123456789
```

### Configure Commands

Edit `config/commands.yaml` to define available commands:

```yaml
commands:
  - prefix: "run"
    binary: "bash"
    args: ["-c"]
    mode: one-shot
    envelope: false
    description: "Run a shell command"

  - prefix: "claude"
    binary: "claude"
    args: ["--verbose"]
    promptFlag: "-p"
    sessionIdFlag: "--session-id"
    resumeFlag: "--resume"
    mode: one-shot
    envelope: true
    description: "Run Claude Code"

  - prefix: "kimi"
    binary: "kimi"
    args: []
    promptFlag: "-p"
    sessionIdFlag: "-S"
    mode: one-shot
    envelope: true
    description: "Run Kimi CLI"
```

### Configure Authorization

Edit `config/authorization.yaml` to control access:

```yaml
rules:
  - channels: ["C0123456789"]
    users: ["*"]  # Any user in ALLOWED_USER_IDS
    allowed_prefixes: ["claude", "kimi", "run"]

  - channels: ["C9876543210"]
    users: ["U0123456789"]  # Only specific user
    allowed_prefixes: ["run"]  # Only shell commands
```

## 🚀 Starting the Bot

```bash
cd d:\Dados\Code\slack-llm-runner

# Kill any existing processes
pkill -9 node || taskkill /F /IM node.exe

# Wait 10 seconds for Slack to release old connections
sleep 10

# Start the bot (development mode)
npm run dev

# Or for production:
npm run build
npm start
```

You should see: `⚡️ Bot connected and listening for messages...`

## 📝 Using the Bot

Once connected, send commands in your configured channel:

```
run: echo "Hello World"
run: date
run: pwd
run: ls -la /usr/bin

claude: write a Python function to sort a list
kimi: explain this error message
```

The bot will:
1. Post "Session started" message
2. Execute the command
3. Post "Session complete" message with exit code

### Thread Follow-Ups

Reply in the thread to continue a conversation:

```
You:      claude: my name is Alice
Bot:      🚀 Session started — Run Claude Code
          ✅ Session complete (exit code 0)

You [reply in thread]: what is my name?
Bot:      🚀 Session started — Run Claude Code (resumed)
          ✅ Session complete (exit code 0)
          Output: Your name is Alice.
```

## 📊 Monitoring

Check logs in real-time:
```bash
tail -f logs/bot.log
```

View session outputs:
```bash
ls logs/sessions/
cat logs/sessions/session_*.log
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
   - Go to [api.slack.com/apps](https://api.slack.com/apps) → Your App
   - Generate new App-Level Token (`connections:write` scope)
   - Generate new Bot User OAuth Token
   - Update `.env` file
   - Restart bot

### Command Output Not Captured

**Symptom**: Bot shows "Exited with code 0" but no output in Slack

**Status**: This is a known limitation with node-pty + Windows environment
- Command executes successfully (exit code 0)
- Output is captured in session logs: `logs/sessions/session_*.log`
- Can see output by running: `tail -f logs/sessions/session_*.log`

## 🔧 Configuration Files Reference

| File | Purpose |
|------|---------|
| `.env` | Slack tokens and basic settings |
| `config/authorization.yaml` | Channel/user permissions |
| `config/commands.yaml` | Command definitions and prefixes |
| `config/jobs.yaml` | Scheduled jobs (cron) |
| `config/prompts/` | System prompts for LLM modes |

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
cd d:\Dados\Code\slack-llm-runner
rm logs/bot.log
rm logs/sessions/*.log
```
