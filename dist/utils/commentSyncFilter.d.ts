import type { TgChainRecord } from '../api/adminPanelState';
import type { TgMessage } from '../forwarder/telegramReader';
/** Режим сопоставления слов для переноса комментариев TG → MAX. */
export type CommentSyncMatchMode = 'contains' | 'equals' | 'word' | 'starts_with' | 'ends_with';
export declare function normalizeCommentSyncMatchMode(mode: string | undefined | null): CommentSyncMatchMode;
export declare function normalizeCommentSyncKeywords(words: string[] | undefined): string[];
export interface ParsedCommentSyncKeyword {
    pattern: string;
    mode: CommentSyncMatchMode;
}
/** Разбирает тег: префикс `= ^ $ # ~` переопределяет режим для одного слова. */
export declare function parseCommentSyncKeyword(raw: string, defaultMode: CommentSyncMatchMode): ParsedCommentSyncKeyword | null;
export declare function matchesCommentSyncPattern(text: string, pattern: string, mode: CommentSyncMatchMode): boolean;
export declare function matchesCommentSyncKeyword(text: string, keywords: string[], defaultMode?: CommentSyncMatchMode): boolean;
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
/** Комментарий из TG-треда (не создан в MAX miniapp). */
export declare function isTelegramOriginComment(comment: {
    source?: 'telegram' | 'max';
}): boolean;
/** Маркер на исходном комментарии в TG после ответа админа в MAX (без нового сообщения в треде). */
export declare const MAX_ANSWERED_IN_MAX_MARKER = "\uD83D\uDD12 \u0417\u0430\u0431\u0440\u043E\u043D\u0438\u0440\u043E\u0432\u0430\u043D \u0432 MAX";
/** Старый маркер — учитываем при проверке уже помеченных сообщений. */
export declare const LEGACY_ANSWERED_IN_MAX_MARKER = "\u2705 \u041E\u0442\u0432\u0435\u0447\u0435\u043D\u043E \u0432 MAX";
/** Подпись в miniapp: на комментарий ответили в Telegram. */
export declare const MAX_ANSWERED_IN_TELEGRAM_LABEL = "\u2705 \u041E\u0442\u0432\u0435\u0447\u0435\u043D\u043E \u0432 Telegram";
/** Служебное сообщение в TG-треде: пост забронирован первым комментарием из MAX. */
export declare const TG_BOOKED_IN_MAX_MARKER = "\uD83D\uDD12 \u0417\u0430\u0431\u0440\u043E\u043D\u0438\u0440\u043E\u0432\u0430\u043D\u043E \u0432 \u041C\u0410\u041A\u0421\u0435";
/** MAX inline callback для неактивной кнопки «Забронировано в ТГ». */
export declare const MAX_BOOKED_IN_TG_CALLBACK = "max:booked_tg";
export declare function formatMaxBookedInTgButtonLabel(commentCount: number): string;
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
    commentsBookedBy?: 'telegram' | 'max' | null;
}): Promise<boolean>;
