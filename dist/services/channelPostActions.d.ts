import { Bot } from '@maxhub/max-bot-api';
import type { Message, User } from '@maxhub/max-bot-api/types';
import { type Post } from './postStore';
/**
 * Resolves chat id for a message (channel/group/dialog). Falls back to sender id for 1:1.
 */
export declare function resolveMessageChatId(message: Message, fallbackUserId: number): number;
export type RegisteredChannelLookup = {
    chatId: number;
    title: string | null;
};
/**
 * Сообщение из канала, уже записанного в реестр бота (без лишнего getChat).
 */
export declare function lookupRegisteredChannelForMessage(message: Message): RegisteredChannelLookup | null;
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
    reason: 'no_chat_id' | 'no_mid' | 'skip_bot' | 'no_miniapp' | 'not_admin' | 'already_exists' | 'attach_failed' | 'chain_comments_disabled';
};
export type CommentButtonAttachSource = 'webhook' | 'poller' | 'refresh' | 'manual' | 'ensure' | 'tg_chain';
export declare function buildPostFromChannelMessage(message: Message, chatId: number, postId: string, user?: User): Post;
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
    source?: CommentButtonAttachSource;
    inlineOnly?: boolean;
    /** When recovering an orphan button link, reuse this `post_id` if the row is new. */
    preferredPostId?: string;
}): Promise<AttachChannelCommentsResult>;
/** Loads the original channel post message for a stored {@link Post}. */
export declare function loadChannelPostMessage(bot: Bot, post: Post): Promise<Message | null>;
/**
 * Loads a channel message from MAX and registers it in {@link postStore} if missing.
 * Used when Mini App opens with `message_mid` but the post row was lost (DB reset, migration).
 */
export declare function ensurePostFromChannelMessage(bot: Bot, chatId: number, messageMid: string, options?: {
    inlineOnly?: boolean;
    preferredPostId?: string;
    reattachButton?: boolean;
}): Promise<Post | null>;
