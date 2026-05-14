export type ReceiveMode = 'webhook' | 'polling';
export interface Config {
    BOT_TOKEN: string;
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
