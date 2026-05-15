import { Bot } from '@maxhub/max-bot-api';
/**
 * Сбрасывает in-memory флаги уведомления о подключении (при ручном «отключении» канала в админке).
 */
export declare function clearAdminJoinNotifiedForChannel(channelChatId: number): void;
export declare function registerEventHandlers(bot: Bot): void;
