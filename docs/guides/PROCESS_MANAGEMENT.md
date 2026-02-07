# Process Management Guide

## Problem: Orphaned Node Processes

The bot uses Slack Socket Mode, which only allows **ONE active connection per app token**. When testing or restarting frequently, orphaned node processes can accumulate, preventing the bot from connecting.

## Solutions

### 1. **Quick Cleanup (Recommended)**

```bash
# Add npm scripts to package.json
npm run clean          # Kill all node processes
npm run restart        # Clean + wait 2s + restart bot
```

### 2. **Manual Cleanup**

PowerShell:
```powershell
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
```

Windows Command Prompt:
```cmd
taskkill /IM node.exe /F
```

### 3. **Better Testing Practices**

**Use E2E tests instead of manual Slack testing:**
```bash
npm run test:lifecycle    # All 4 session lifecycle tests pass
npm test                  # All processHandle tests pass
```

Tests automatically clean up processes on completion - no orphaned processes.

### 4. **Long-Running Bot (Production)**

For running the bot continuously:

**Option A: Use PM2**
```bash
npm install -g pm2
pm2 start npm --name slack-bot -- run start
pm2 logs slack-bot
pm2 stop slack-bot
pm2 delete slack-bot
```

**Option B: Use Node's built-in capabilities**
- Run in a screen or tmux session
- Use systemd service (Linux)
- Use Windows Task Scheduler (Windows)

**Option C: Docker**
- Isolates the bot in a container
- Prevents process leaks on host system
- Makes cleanup trivial: `docker stop <container>`

### 5. **Prevent Orphaned Processes**

When running tests:
- ✅ Use `npm run test:lifecycle` - proper cleanup
- ✅ Use `npm test` - proper cleanup
- ❌ Avoid `node test-*.js` - may not clean up properly
- ❌ Avoid running multiple bot instances simultaneously

### 6. **Monitor Active Connections**

Check for orphaned processes:
```powershell
Get-Process node | Select-Object Name,Id,Memory,StartTime
```

If you see multiple node processes with similar memory usage and recent start times, they're likely orphaned.

## Architecture Notes

Socket Mode Limitation:
- Only ONE bot can connect per app token
- Slack automatically disconnects stale connections after ~30s
- But orphaned processes prevent binding to the same token
- Solution: Always clean up before restarting

Session Lifecycle:
- E2E tests in `test/e2e-session-lifecycle.test.ts` validate:
  - Full start → output → end marker lifecycle
  - Concurrent session handling
  - Error handling
  - Exit code capture
- These tests prove the core functionality works correctly
- Use them for validation instead of manual Slack testing

## When to Use Manual Testing vs E2E Tests

| Scenario | Use |
|----------|-----|
| Validating core functionality | E2E tests |
| Testing UI/UX in Slack | Manual (after E2E pass) |
| Debugging a specific feature | E2E test in isolation |
| Integration testing | E2E tests |
| One-off quick check | E2E test |

## Quick Restart Checklist

1. Run `npm run restart` (replaces manual kill + restart)
2. Wait for "Now connected to Slack" message
3. Test in Slack or run E2E tests: `npm run test:lifecycle`
