import { Bot } from '@maxhub/max-bot-api';
import type { Message } from '@maxhub/max-bot-api/types';
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
    reason: 'no_sender' | 'skip_bot' | 'no_miniapp' | 'not_admin' | 'already_exists';
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
