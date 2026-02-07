import { createLogger } from '../utils/logger.js';

const logger = createLogger('CommandFilter');

/** Blocklist of dangerous command patterns */
const BLOCKED: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f\b/i,                    // rm -rf / rm -fr …
  /\bformat\s+[A-Za-z]:/i,                        // format C:
  /\bshutdown\b/i,                                // shutdown (Windows & Linux)
  /\bpowershell[^|]*-command\s+.*remove/i,        // powershell -command … remove …
  /\bdel\s+\/[sS]\b/i,                            // del /S (recursive Windows delete)
  /\brmdir\s+\/[sS]\b/i,                          // rmdir /S
];

/**
 * Checks a command string against the built-in blocklist.
 * @returns A human-readable reason string if blocked, or null if the command passes.
 */
export function checkCommand(command: string): string | null {
  for (const re of BLOCKED) {
    if (re.test(command)) {
      logger.warn('Command blocked: "%s" matched %s', command, re);
      return `Matches blocked pattern \`${re}\``;
    }
  }
  return null;
}
