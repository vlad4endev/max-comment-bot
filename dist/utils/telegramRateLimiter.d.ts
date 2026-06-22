/**
 * Очередь и rate limiting для Telegram Bot API.
 * Сериализует исходящие запросы, соблюдает минимальный интервал и обрабатывает FLOOD_WAIT.
 */
export interface TelegramBotApiResponse {
    ok: boolean;
    description?: string;
    error_code?: number;
    parameters?: {
        retry_after?: number;
    };
    result?: unknown;
}
/** Минимальный интервал между вызовами Bot API (мс). По умолчанию 2000. */
export declare function getTelegramApiMinIntervalMs(): number;
/** Сколько комментариев обрабатывать за один цикл синхронизации MAX→TG. */
export declare function getTelegramCommentSyncBatchSize(): number;
/** Интервал цикла синхронизации комментариев MAX→TG (мс). */
export declare function getMaxCommentSyncIntervalMs(): number;
export declare function parseFloodWaitSeconds(text: string, parameters?: {
    retry_after?: number;
}): number | null;
export declare function isTelegramApiPaused(): boolean;
export declare function getTelegramApiPauseRemainingMs(): number;
/**
 * Сериализует вызовы Telegram Bot API с минимальным интервалом и учётом FLOOD_WAIT.
 */
export declare function enqueueTelegramApiCall<T>(fn: () => Promise<T>): Promise<T>;
export type TelegramApiCallContext = {
    method: string;
    chatId?: number | string;
    tokenHint?: string;
};
/**
 * POST к Telegram Bot API с rate limiting, retry при FLOOD_WAIT и классификацией ошибок.
 */
export declare function callTelegramBotApi<T extends TelegramBotApiResponse>(token: string, method: string, payload: Record<string, unknown>, context?: TelegramApiCallContext, maxFloodRetries?: number): Promise<T>;
/**
 * Оборачивает MTProto/другие вызовы с FLOOD_WAIT в ту же глобальную паузу.
 */
export declare function withTelegramFloodWaitBackoff<T>(label: string, run: () => Promise<T>, maxRetries?: number): Promise<T>;
