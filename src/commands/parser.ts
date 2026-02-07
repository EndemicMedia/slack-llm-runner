import { type CommandConfig, type ParsedCommand } from '../types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('parser');

/** Built-in slash-style control commands */
const CONTROLS = ['/status', '/stop', '/jobs', '/logs', '/help'];

/**
 * Parses raw message text into a structured command.
 * Checks control commands first, then configured CLI trigger prefixes.
 * @returns null if the text does not match any known command pattern
 */
export function parseCommand(text: string, commands: CommandConfig[]): ParsedCommand | null {
  logger.debug('parseCommand input: text=%O, commandCount=%d', text, commands.length);

  // --- Control commands (slash-style) ---
  for (const ctrl of CONTROLS) {
    const exactMatch = text === ctrl;
    const startsWithMatch = text.startsWith(ctrl + ' ');
    logger.debug('  control test: "%s" → exact=%s, startsWithSpace=%s', ctrl, exactMatch, startsWithMatch);

    if (exactMatch || startsWithMatch) {
      const result = { isControl: true, prefix: ctrl, args: text.slice(ctrl.length).trim() };
      logger.debug('  ✓ MATCHED control command: %O', result);
      return result;
    }
  }

  // --- CLI trigger prefixes (e.g. "claude:", "run:") ---
  logger.debug('  checking %d CLI trigger prefixes...', commands.length);
  for (const cmd of commands) {
    const trigger = cmd.prefix + ':';
    const lowerText = text.toLowerCase();
    const lowerTrigger = trigger.toLowerCase();
    const matches = lowerText.startsWith(lowerTrigger);
    logger.debug('  cli trigger: "%s" → text.toLowerCase().startsWith() = %s', trigger, matches);

    if (matches) {
      const result = { isControl: false, prefix: cmd.prefix, args: text.slice(trigger.length).trim() };
      logger.debug('  ✓ MATCHED CLI command: %O', result);
      return result;
    }
  }

  logger.debug('  ✗ NO MATCH - returning null');
  return null;
}
