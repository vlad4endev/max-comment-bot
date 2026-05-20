/**
 * Планировщик автопостов: setInterval раз в минуту (AUTOPOST_TICK_MS).
 * В проекте уже используются setInterval-воркеры (channelPoller, flowProcessor) —
 * отдельный node-cron/BullMQ не нужен для одного тика в минуту.
 */
export declare function startAutopostScheduler(): void;
export declare function stopAutopostScheduler(): void;
