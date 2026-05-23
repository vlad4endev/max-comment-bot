import type { Bot } from '@maxhub/max-bot-api';
export declare function canManageMaxCommentViaTelegram(bot: Bot, telegramUserId: number, maxChatId: number): Promise<boolean>;
export declare function handleTelegramCommentModerationCallback(update: Record<string, unknown>, bot: Bot): Promise<boolean>;
export declare function tryHandleTelegramCommentModerationReply(bot: Bot, telegramUserId: number, text: string): Promise<boolean>;
