import { schedule, validate, type ScheduledTask } from 'node-cron';
import { type AppConfig, type JobDefinition } from '../types.js';
import { type SlackReporter } from '../slack/reporter.js';
import { type SessionManager } from '../cli/runner.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Scheduler');

/**
 * Loads job definitions from config and registers node-cron schedules.
 * Each job fires a one-shot CLI session and streams output into its
 * target channel thread.
 */
export class Scheduler {
  private readonly tasks = new Map<string, ScheduledTask>();

  constructor(
    private readonly config:   AppConfig,
    private readonly reporter: SlackReporter,
    private readonly runner:   SessionManager,
  ) {}

  /**
   * Registers all jobs from config.  Safe to call multiple times —
   * previously registered tasks are stopped first.
   */
  start(): void {
    this.stop(); // clean slate

    for (const job of this.config.jobs) {
      if (!validate(job.cron)) {
        logger.warn('Invalid cron expression for job "%s": %s — skipped', job.name, job.cron);
        continue;
      }
      const task = schedule(job.cron, () => void this.fire(job));
      this.tasks.set(job.name, task);
      logger.info('Scheduled job "%s" → %s', job.name, job.cron);
    }
  }

  /** Stops all running cron tasks */
  stop(): void {
    for (const task of this.tasks.values()) task.stop();
    this.tasks.clear();
  }

  /** Fires a single scheduled job: posts a header message, then spawns */
  private async fire(job: JobDefinition): Promise<void> {
    logger.info('Firing scheduled job: %s', job.name);
    const label = job.label ?? job.name;

    // Post "starting" notice — this message becomes the thread root
    const threadTs = await this.reporter.postMessage(
      job.channel,
      `🕐 Scheduled job: *${label}* starting…`,
    );

    // Determine the platform shell
    const shell = process.platform === 'win32'
      ? { binary: 'cmd',  args: ['/c'] }
      : { binary: 'bash', args: ['-c'] };

    await this.runner.spawn({
      channelId: job.channel,
      threadTs,
      command:   job.command,
      config: {
        prefix:      job.name,
        binary:      shell.binary,
        args:        shell.args,
        mode:        'one-shot',
        envelope:    false,
        description: label,
      },
      cwd: job.cwd,
    });
  }
}
