import type { Bot } from '@maxhub/max-bot-api';
import express from 'express';
export interface WebhookAppOptions {
    bot: Bot;
    webhookPath: string;
    /** Если задан — отклонять запросы без совпадающего заголовка `X-Max-Bot-Api-Secret` */
    webhookSecret?: string;
}
export declare function createWebhookApp(options: WebhookAppOptions): express.Express;
