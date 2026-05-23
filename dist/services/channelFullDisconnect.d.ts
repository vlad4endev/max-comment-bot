import type { Bot } from '@maxhub/max-bot-api';
export type ChannelFullDisconnectReason = 'removed_from_chat' | 'lost_admin_rights' | 'manual_admin_panel'
/** Реестр устарел: getChat не проходит, уведомления не шлём. */
 | 'registry_stale_removed';
export type RegisteredChannelAccess = 'ok' | 'chat_unreachable' | 'bot_not_in_chat' | 'bot_not_admin';
/**
 * Live check: chat exists for the bot and the bot is still a member with admin/owner rights.
 */
export declare function resolveRegisteredChannelAccess(bot: Bot, chatId: number): Promise<RegisteredChannelAccess>;
/**
 * Удаляет все локальные данные канала (SQLite, JSON, in-memory), не трогая глобальных подписчиков бота.
 */
export declare function purgeAllChannelData(chatId: number): Promise<void>;
/**
 * Removes all bot-side data for a registered channel (registry, posts, comments, notify links)
 * and optionally notifies channel admins in DM before links are dropped.
 */
export declare function fullyDisconnectRegisteredChannel(bot: Bot, chatId: number, reason: ChannelFullDisconnectReason): Promise<boolean>;
/**
 * Периодическая проверка доступа к каналам (не чаще раза в ~90 с), чтобы админ-панель
 * не блокировалась на MAX API при каждом запросе.
 */
export declare function maybePruneRegisteredChannelsNotAccessibleByBot(bot: Bot, options?: {
    force?: boolean;
}): Promise<void>;
/**
 * Удаляет из реестра каналы, к которым бот больше не имеет доступа
 * (чат удалён, бот выгнан; без прав админа остаются для статуса «ожидает прав»).
 */
export declare function pruneRegisteredChannelsNotAccessibleByBot(bot: Bot): Promise<void>;
