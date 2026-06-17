/**
 * telegramThreadReplySync.ts
 *
 * MAX miniapp → TG discussion group: пользовательские комментарии и ответы админа.
 */
import type { Bot } from '@maxhub/max-bot-api';
import type { Comment } from './commentStore';
import type { Post } from './postStore';
/**
 * Помечает исходный комментарий в TG-треде как отвеченный в MAX.
 * @returns true если сообщение успешно помечено (edit или reaction)
 */
export declare function markTelegramCommentAnsweredInMax(token: string, chatId: number, tgCommentId: number, commentText: string, options?: {
    messageThreadId?: number;
    commentId?: string;
}): Promise<boolean>;
/**
 * Отправляет пользовательский комментарий из MAX miniapp в TG-тред.
 */
export declare function syncMaxCommentToTelegramThread(_bot: Bot, comment: Comment, post: Post): Promise<void>;
/**
 * Отправляет ответ администратора из MAX в TG-тред только если комментарий
 * не привязан к TG (fallback). Для MAX→TG комментариев — только правка маркера.
 */
export declare function syncAdminReplyToTelegramThread(_bot: Bot, comment: Comment, post: Post): Promise<void>;
