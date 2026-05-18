import type { Bot } from '@maxhub/max-bot-api';
/** Exported for startup diagnostics. */
export declare const POLL_CONCURRENCY = 5;
/**
 * One sweep for a single channel (admin «обновить кнопки»).
 */
export declare function runChannelPollerForChat(bot: Bot, chatId: number): Promise<void>;
/**
 * One sweep: for each registered channel, fetch recent messages and attach the comment button to new admin posts.
 */
export declare function runChannelPollerTick(bot: Bot): Promise<void>;
/**
 * Starts periodic polling of registered channels. No-op if Mini App open URL is not configured.
 */
export declare function startChannelPostPoller(bot: Bot, intervalMs?: number): void;
/**
 * Перезапуск таймера с разрешением из {@link adminRuntimeSettingsStore}.
 */
export declare function restartChannelPostPoller(bot: Bot): void;
export declare function stopChannelPostPoller(): void;
