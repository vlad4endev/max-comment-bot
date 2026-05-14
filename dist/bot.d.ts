import type { Server } from 'node:http';
import { Bot } from '@maxhub/max-bot-api';
declare function initializeBot(): Bot;
declare function ensureBotProfile(bot: Bot): Promise<void>;
declare function startBotLongPolling(bot: Bot): Promise<void>;
export interface GracefulShutdownOptions {
    receiveMode: 'webhook' | 'polling';
    httpServer?: Server;
    webhookUrl?: string;
}
declare function setupGracefulShutdown(bot: Bot, options: GracefulShutdownOptions): void;
export { initializeBot, ensureBotProfile, startBotLongPolling, setupGracefulShutdown, };
