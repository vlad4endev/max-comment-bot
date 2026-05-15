import type { Bot } from '@maxhub/max-bot-api';
export type ChannelFullDisconnectReason = 'removed_from_chat' | 'lost_admin_rights' | 'manual_admin_panel'
/** Реестр устарел: getChat не проходит, уведомления не шлём. */
 | 'registry_stale_removed';
/**
 * Removes all bot-side data for a registered channel (registry, posts, comments, notify links)
 * and optionally notifies channel admins in DM before links are dropped.
 */
export declare function fullyDisconnectRegisteredChannel(bot: Bot, chatId: number, reason: ChannelFullDisconnectReason): Promise<boolean>;
/**
 * Удаляет из реестра каналы типа `channel`, для которых {@link Bot.api.getChat} больше не проходит
 * (бот выгнан, чат удалён и т.п.), чтобы админка и поллер не показывали «мёртвые» записи.
 */
export declare function pruneRegisteredChannelsNotAccessibleByBot(bot: Bot): Promise<void>;
