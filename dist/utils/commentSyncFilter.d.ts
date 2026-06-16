import type { TgChainRecord } from '../api/adminPanelState';
import type { TgMessage } from '../forwarder/telegramReader';
export declare function normalizeCommentSyncKeywords(words: string[] | undefined): string[];
export declare function matchesCommentSyncKeyword(text: string, keywords: string[]): boolean;
export declare function isTgCommentFromAdmin(message: TgMessage, token: string, chain: TgChainRecord, discussionChatId: number): Promise<boolean>;
/** Поднимается по цепочке reply_to_message к корню треда (авто-репост канала). */
export declare function resolveThreadRootMessage(message: TgMessage): TgMessage['reply_to_message'] | null;
export declare function resolveDiscussionThreadRootMsgId(message: TgMessage): number | null;
/** ID поста в TG-канале из авто-репоста в discussion group. */
export declare function resolveChannelMsgIdFromThreadRoot(root: NonNullable<TgMessage['reply_to_message']>): number | null;
export declare function resolveTgCommentAuthor(message: TgMessage, chain: TgChainRecord, discussionChatId: number): {
    userId: number;
    username: string;
};
/** Маркер на исходном комментарии в TG после ответа из MAX. */
export declare const MAX_ANSWERED_IN_MAX_MARKER = "\u2705 \u041E\u0442\u0432\u0435\u0447\u0435\u043D\u043E \u0432 MAX";
/** Подпись в miniapp: на комментарий ответили в Telegram. */
export declare const MAX_ANSWERED_IN_TELEGRAM_LABEL = "\u2705 \u041E\u0442\u0432\u0435\u0447\u0435\u043D\u043E \u0432 Telegram";
export declare function isTelegramCommentMarkedAnsweredInMax(text: string): boolean;
/** Префикс ответа админа из MAX в TG-треде (не синхронизировать обратно в miniapp). */
export declare const MAX_REPLY_TG_PREFIX = "MAX \u043E\u0442\u0432\u0435\u0442:";
/** Префикс пользовательского комментария из MAX в TG-треде. */
export declare const MAX_COMMENT_TG_PREFIX = "MAX \u00B7";
export declare function isMaxAdminReplyInTelegram(text: string): boolean;
export declare function isMaxCommentInTelegram(text: string): boolean;
/** Текст сообщения в TG-треде: имя автора и комментарий из MAX miniapp. */
export declare function formatMaxCommentForTelegram(username: string, text: string): string;
export declare function shouldSyncTgCommentToMax(params: {
    message: TgMessage;
    chain: TgChainRecord;
    token: string;
    discussionChatId: number;
    postCommentCount: number;
    threadRootMsgId: number;
}): Promise<boolean>;
