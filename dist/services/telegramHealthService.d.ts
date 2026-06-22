/**
 * Периодическая проверка авторизации Telegram Bot API (getMe).
 */
export interface TelegramHealthSnapshot {
    checked_at: string;
    has_token: boolean;
    api_ok: boolean;
    bot_id: number | null;
    bot_username: string | null;
    error: string | null;
}
export interface TelegramTokenSourceReport {
    active_source: 'integrations' | 'env' | 'none';
    active_token_preview: string;
    env_token_preview: string;
    integrations_token_preview: string;
    reader_token_preview: string;
    reader_uses_main: boolean;
    env_differs_from_integrations: boolean;
    mismatch_warning: string | null;
}
/** Откуда реально берётся основной TG-токен (без раскрытия полного значения). */
export declare function describeTelegramTokenSources(): TelegramTokenSourceReport;
export declare function isTelegramTokenAuthorized(token: string): Promise<boolean>;
export declare function probeTelegramBotApi(token?: string): Promise<TelegramHealthSnapshot>;
export declare function getTelegramHealthSnapshot(): TelegramHealthSnapshot;
export declare function assertTelegramBotApiOnStartup(): Promise<void>;
export declare function startTelegramHealthMonitor(): void;
export declare function stopTelegramHealthMonitor(): void;
