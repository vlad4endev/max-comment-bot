import { Bot } from '@maxhub/max-bot-api';
import type { Message } from '@maxhub/max-bot-api/types';
import { type Post } from './postStore';
/**
 * Resolves chat id for a message (channel/group/dialog). Falls back to sender id for 1:1.
 */
export declare function resolveMessageChatId(message: Message, fallbackUserId: number): number;
/**
 * Channel posts usually have `recipient.chat_type === 'channel'`; otherwise confirm via getChat.
 */
export declare function isLikelyChannelPost(bot: Bot, message: Message): Promise<boolean>;
/** True if the user is a non-bot admin or owner of the channel. */
export declare function isUserChannelAdmin(bot: Bot, channelChatId: number, userId: number): Promise<boolean>;
export type AttachChannelCommentsResult = {
    ok: true;
} | {
    ok: false;
    reason: 'no_chat_id' | 'no_mid' | 'skip_bot' | 'no_miniapp' | 'not_admin' | 'already_exists';
};
/**
 * Creates a {@link Post}, saves it, and attaches the Mini App inline button (edit or reply fallback).
 *
 * @param options.skipAuthorAdminCheck — when the invoker was already verified (e.g. `/addbutton`).
 * @param options.channelChatIdOverride — e.g. poller passes registered channel id when recipient metadata is thin.
 */
export declare function tryAttachCommentsToChannelPost(bot: Bot, message: Message, options?: {
    botUserId?: number;
    channelChatIdOverride?: number;
    skipAuthorAdminCheck?: boolean;
}): Promise<AttachChannelCommentsResult>;
/**
 * Loads a channel message from MAX and registers it in {@link postStore} if missing.
 * Used when Mini App opens with `message_mid` but the post row was lost (DB reset, migration).
 */
export declare function ensurePostFromChannelMessage(bot: Bot, chatId: number, messageMid: string): Promise<Post | null>;
