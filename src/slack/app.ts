import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { App } = require('@slack/bolt');

/**
 * Creates a Bolt App instance configured for Socket Mode.
 * No public URL is required — the connection is an outbound WebSocket
 * authenticated via the app-level token.
 */
export function createApp(botToken: string, appToken: string) {
  return new App({
    token:      botToken,   // Bot token for Web API calls
    appToken,               // App token for Socket Mode WebSocket
    socketMode: true,
  });
}
