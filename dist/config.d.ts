export type ReceiveMode = 'webhook' | 'polling';
export interface Config {
    BOT_TOKEN: string;
    ADMIN_CHAT_ID: number;
    BOT_NICKNAME: string;
    NODE_ENV: 'development' | 'production';
    PORT: number;
    receiveMode: ReceiveMode;
    /** Только для webhook-режима */
    webhookUrl?: string;
    /** pathname из `webhookUrl` (например `/webhook`) */
    webhookPath?: string;
    /** Проверка заголовка `X-Max-Bot-Api-Secret` (рекомендуется MAX) */
    webhookSecret?: string;
}
export declare const config: Config;
