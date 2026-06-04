import type { Bot } from '@maxhub/max-bot-api';
export declare function setTgChainForwarderBot(bot: Bot): void;
export declare function getTgChainForwarderBot(): Bot | null;
/** Long-poll / drain TG updates for main CommentBot (my_chat_member, /start, callbacks). */
export declare function syncMainTelegramBotDiscoveryUpdates(tgToken: string, options?: {
    timeoutSec?: number;
    maxPages?: number;
}): Promise<number>;
export declare function runTgChainsOnce(): Promise<boolean>;
export declare function startTgChainForwarder(): void;
