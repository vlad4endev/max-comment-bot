/**
 * Планировщик автопостов: setInterval раз в минуту (AUTOPOST_TICK_MS).
 */
export declare function startAutopostScheduler(): void;
export declare function stopAutopostScheduler(): void;
/** Немедленный проход планировщика (после создания/обновления поста). */
export declare function triggerAutopostTick(): void;
export declare function getAutopostSchedulerStatus(): {
    running: boolean;
    tickMs: number;
    startedAt: string | null;
    lastTickAt: string | null;
    lastDueCount: number;
    lastError: string | null;
    dbPath: string;
    totalPosts: number;
    activePosts: number;
    dueNow: number;
};
