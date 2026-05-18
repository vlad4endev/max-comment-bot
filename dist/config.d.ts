export type ReceiveMode = 'webhook' | 'polling';
/** Токен Telegram-бота (из `.env`, синхронизируется из админ-панели). */
export declare function getTelegramToken(): string;
export interface Config {
    BOT_TOKEN: string;
    /** Опционально: TG_TOKEN из .env (дублирует getTelegramToken на старте). */
    TG_TOKEN: string;
    /**
     * Единственный владелец панели /admin (числовой user_id в MAX).
     */
    ownerUserId: number;
    /**
     * Первые 16 hex-символов sha256(ownerUserId + BOT_TOKEN) — устаревший токен (совместимость).
     */
    adminToken: string;
    /** Логин веб-панели `/admin` (переопределяется `ADMIN_PANEL_USER`). */
    adminPanelUser: string;
    /** Пароль веб-панели (переопределяется `ADMIN_PANEL_PASSWORD`). */
    adminPanelPassword: string;
    /** Секрет подписи cookie сессии панели (`ADMIN_PANEL_SESSION_SECRET` или производное от BOT_TOKEN). */
    adminPanelSessionSecret: string;
    ADMIN_CHAT_ID: number;
    BOT_NICKNAME: string;
    /**
     * Никнейм без @ для deep link MAX: `https://max.ru/<botNickname>?startapp=…`.
     */
    botNickname: string;
    NODE_ENV: 'development' | 'production';
    PORT: number;
    /**
     * Порт HTTP (webhook + /api + /static). Если задан API_PORT — используется он, иначе PORT.
     */
    listenPort: number;
    /**
     * Legacy: прямой URL мини-приложения с query (`post_id`, `chat_id`). Используется только если не удалось собрать ссылку через {@link Config.botNickname}.
     */
    miniAppUrl?: string;
    receiveMode: ReceiveMode;
    /** Только для webhook-режима */
    webhookUrl?: string;
    /** pathname из `webhookUrl` (например `/webhook`) */
    webhookPath?: string;
    /** Проверка заголовка `X-Max-Bot-Api-Secret` (рекомендуется MAX) */
    webhookSecret?: string;
}
export declare const config: Config;
