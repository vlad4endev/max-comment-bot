import type { Bot } from '@maxhub/max-bot-api';
export type ChannelFullDisconnectReason = 'removed_from_chat' | 'lost_admin_rights' | 'manual_admin_panel';
/**
 * Removes all bot-side data for a registered channel (registry, posts, comments, notify links)
 * and optionally notifies channel admins in DM before links are dropped.
 */
export declare function fullyDisconnectRegisteredChannel(bot: Bot, chatId: number, reason: ChannelFullDisconnectReason): Promise<boolean>;
