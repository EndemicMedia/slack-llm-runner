import { type AppConfig } from '../types.js';

/**
 * Evaluates incoming messages against the configured allowlists
 * (channels, users, command prefixes) defined in authorization.yaml.
 */
export class Authorizer {
  constructor(private readonly config: AppConfig) {}

  /** Returns true if the channel appears in at least one auth rule */
  isChannelAllowed(channelId: string): boolean {
    return this.config.auth.rules.some((r) => r.channels.includes(channelId));
  }

  /**
   * Returns true if the user matches a rule for the given channel.
   * If rule has '*' wildcard, allows any user. Otherwise requires user to be in rule list.
   */
  isUserAllowed(userId: string, channelId: string): boolean {
    return this.config.auth.rules.some(
      (r) => r.channels.includes(channelId) &&
             (r.users.includes('*') || r.users.includes(userId)),
    );
  }

  /** Returns true if the given command prefix is permitted in the channel */
  isPrefixAllowed(prefix: string, channelId: string): boolean {
    return this.config.auth.rules
      .filter((r) => r.channels.includes(channelId))
      .some((r) => r.allowed_prefixes.includes(prefix));
  }
}
