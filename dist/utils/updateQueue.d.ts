/** Максимум одновременных обработок webhook-update. */
export declare const WEBHOOK_CONCURRENCY = 10;
/**
 * Ограничивает параллелизм обработки входящих MAX updates (webhook POST).
 */
export declare function enqueueUpdate<T>(fn: () => Promise<T>): Promise<T>;
