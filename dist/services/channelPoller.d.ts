import type { Bot } from '@maxhub/max-bot-api';
/**
 * One sweep: for each registered channel, fetch recent messages and attach the comment button to new admin posts.
 */
export declare function runChannelPollerTick(bot: Bot): Promise<void>;
/**
 * Starts periodic polling of registered channels. No-op if {@link config.miniAppUrl} is unset.
 */
export declare function startChannelPostPoller(bot: Bot, intervalMs?: number): void;
export declare function stopChannelPostPoller(): void;
