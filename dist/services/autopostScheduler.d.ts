/**
 * Планировщик автопостов: setInterval раз в минуту (AUTOPOST_TICK_MS).
 */
export declare function startAutopostScheduler(): void;
export declare function stopAutopostScheduler(): void;
/** Немедленный проход планировщика (после создания/обновления поста). */
export declare function triggerAutopostTick(): void;
