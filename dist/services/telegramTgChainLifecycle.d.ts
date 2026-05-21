import type { Bot } from '@maxhub/max-bot-api';
export declare function setTelegramTgChainLifecycleBot(bot: Bot): void;
/**
 * Бот потерял права администратора в TG-канале: приостанавливаем связки и уведомляем админов MAX.
 */
export declare function pauseTgChainsForTelegramChannelLostAdmin(input: {
    tgChannelChatId: string;
    tgTitle: string | null;
    tgUsername: string | null;
}): Promise<{
    pausedChainIds: string[];
}>;
/**
 * Права администратора в TG восстановлены: возобновляем автоприостановленные связки и уведомляем MAX.
 */
export declare function restoreTgChainsForTelegramChannelAdminRestored(input: {
    tgChannelChatId: string;
    tgTitle: string | null;
    tgUsername: string | null;
}): Promise<{
    restoredChainIds: string[];
}>;
