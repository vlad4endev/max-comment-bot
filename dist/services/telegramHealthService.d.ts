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
export declare function probeTelegramBotApi(token?: string): Promise<TelegramHealthSnapshot>;
export declare function getTelegramHealthSnapshot(): TelegramHealthSnapshot;
export declare function assertTelegramBotApiOnStartup(): Promise<void>;
export declare function startTelegramHealthMonitor(): void;
export declare function stopTelegramHealthMonitor(): void;
