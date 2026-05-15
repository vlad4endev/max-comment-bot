import type { Bot } from '@maxhub/max-bot-api';
import express from 'express';
export interface HttpAppOptions {
    bot: Bot;
    /** Если задан — регистрируется POST webhook для MAX */
    webhook?: {
        path: string;
        secret?: string;
    };
}
/** @deprecated Используйте {@link HttpAppOptions} + {@link createHttpApp} */
export interface WebhookAppOptions {
    bot: Bot;
    webhookPath: string;
    webhookSecret?: string;
}
/**
 * Express-приложение: GET /health, статика Mini App (`/miniapp`), REST `/api`, опционально POST webhook.
 */
export declare function createHttpApp(options: HttpAppOptions): express.Express;
export declare function createWebhookApp(options: WebhookAppOptions): express.Express;
