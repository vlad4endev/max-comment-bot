import type { Bot } from '@maxhub/max-bot-api';
import { type Comment } from './commentStore';
export declare const TG_COMMENT_CALLBACK_PREFIX = "tgc:";
export declare function resolveTelegramSourceChannelsForMaxChat(maxChatId: number): string[];
/**
 * Кто получает TG-DM о комментариях MAX-канала (зеркало MAX: opt-in + админы, у кого есть Telegram).
 */
export declare function collectTelegramAdminNotifyRecipientIds(bot: Bot, maxChannelChatId: number): Promise<number[]>;
export declare function buildNewCommentNotificationMessage(input: {
    postText: string;
    channelTitle: string;
    username: string;
    commentText: string;
    commentPhotoUrls?: string[];
}): string;
type TgInlineButton = {
    text: string;
    web_app: {
        url: string;
    };
} | {
    text: string;
    url: string;
} | {
    text: string;
    callback_data: string;
};
export declare function buildTelegramCommentNotificationKeyboard(input: {
    postId: string;
    maxChatId: number;
    messageMid?: string;
    telegramUserId: number;
    commentId: string;
    answered: boolean;
    includeModeration?: boolean;
}): {
    inline_keyboard: TgInlineButton[][];
};
export declare function notifyTelegramAdminsNewMiniappComment(bot: Bot, input: {
    commentId: string;
    maxChannelChatId: number;
    postText: string;
    channelTitle: string;
    username: string;
    commentText: string;
    commentPhotoUrls?: string[];
    postId: string;
    messageMid?: string;
}): Promise<void>;
export declare function syncTelegramAdminCommentNotification(input: {
    comment: Comment;
    postId: string;
    channelChatId: number;
    messageMid?: string;
    deleted?: boolean;
}): Promise<void>;
export {};
