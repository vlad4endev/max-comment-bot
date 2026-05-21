import type { Bot } from '@maxhub/max-bot-api';
/** Admin «обновить кнопки»: окно сканирования (последние сутки). */
export declare const REFRESH_BUTTON_LOOKBACK_MS: number;
/** Exported for startup diagnostics. */
export declare const POLL_CONCURRENCY = 8;
/**
 * У каждого канала свой таймер — очередь не блокирует «хвостовые» каналы на минуты.
 */
export declare function syncPerChannelPollers(bot: Bot): void;
export interface RefreshButtonsStats {
    chat_id: number;
    lookback_hours: number;
    messages_fetched: number;
    /** Постов в базе за lookback (обработаны при refresh). */
    posts_in_db: number;
    /** Всего постов канала в базе (справочно). */
    posts_in_db_total: number;
    created: number;
    refreshed: number;
    skipped: number;
    failed: number;
}
export declare class RefreshButtonsError extends Error {
    readonly code: 'miniapp_not_configured' | 'channel_not_found' | 'api_error';
    constructor(code: 'miniapp_not_configured' | 'channel_not_found' | 'api_error', message: string);
}
/**
 * One sweep for a single channel (admin «обновить кнопки»).
 */
export declare function runChannelPollerForChat(bot: Bot, chatId: number): Promise<RefreshButtonsStats>;
/**
 * @deprecated Используется syncPerChannelPollers; оставлено для совместимости вызовов.
 */
export declare function runChannelPollerTick(bot: Bot): Promise<void>;
/**
 * Запускает опрос каждого канала по отдельному таймеру + синхронизацию при изменении реестра.
 */
export declare function startChannelPostPoller(bot: Bot, intervalMs?: number): void;
/**
 * Перезапуск таймеров с разрешением из {@link adminRuntimeSettingsStore}.
 */
export declare function restartChannelPostPoller(bot: Bot): void;
/** Сбрасывает счётчик ошибок поллера для канала (после полного отключения). */
export declare function clearChannelPollerErrors(chatId: number): void;
export declare function stopChannelPostPoller(): void;
/** Вызвать после добавления/удаления канала в реестре (если поллер уже запущен). */
export declare function notifyChannelRegistryChanged(): void;
