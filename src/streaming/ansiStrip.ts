/** Matches ANSI CSI sequences and common escape patterns */
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/**
 * Strips ANSI escape sequences and lone carriage returns from a string.
 * Safe to call on any input; returns the original string unchanged if
 * there is nothing to strip.
 */
export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '').replace(/\r/g, '');
}
