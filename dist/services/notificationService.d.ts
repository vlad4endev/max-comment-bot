import type { Bot } from '@maxhub/max-bot-api';
import type { Comment } from './commentStore';
export interface AdminNotificationSendResult {
    admin_id: number;
    message_mid: string;
}
/** Доп. параметры отправки сообщения (клавиатура и т.д.), как у `bot.api.sendMessageToUser`. */
export type SendMessageExtra = NonNullable<Parameters<Bot['api']['sendMessageToUser']>[2]>;
/**
 * Возвращает user_id админов и владельцев чата (роли в API: {@link ChatMember.is_admin} / {@link ChatMember.is_owner}).
 * Вызывает {@link Bot.api.getChatAdmins} → `GET chats/{chat_id}/members/admins`.
 */
export declare function getChannelAdmins(bot: Bot, chatId: number): Promise<number[]>;
export declare function deliverAdminNotifications(bot: Bot, sourceChatId: number, recipientIds: number[], message: string, extra?: SendMessageExtra): Promise<AdminNotificationSendResult[]>;
/**
 * Кто получает DM: сначала явно подключившиеся через invite, плюс админы/владельцы из API.
 */
export declare function collectAdminNotifyRecipientIds(bot: Bot, channelChatId: number): Promise<number[]>;
/**
 * Уведомляет всех админов канала личными сообщениями; для `ADMIN_CHAT_ID` используется `sendMessageToChat` (супер-админ / группа).
 * Возвращает пары `admin_id` / `message_mid` только для успешно отправленных сообщений.
 */
export declare function notifyAllAdmins(bot: Bot, chatId: number, message: string, extra?: SendMessageExtra, skipUserIds?: ReadonlySet<number>): Promise<AdminNotificationSendResult[]>;
/**
 * Уведомляет админов канала о новом комментарии из Mini App (текст + ссылка на приложение с admin=1).
 */
export declare function notifyAdminsNewMiniappComment(bot: Bot, input: {
    commentId: string;
    channelChatId: number;
    postText: string;
    channelTitle: string;
    username: string;
    commentText: string;
    commentPhotoUrls?: string[];
    postId: string;
}): Promise<void>;
/**
 * Текст одного DM админу: исходное «новый комментарий» без изменений.
 * Статус «отвечено» — на инлайн-кнопке после ответа канала.
 */
export declare function buildAdminCommentNotificationBody(comment: Comment): string | null;
/**
 * Обновляет одно и то же уведомление админам о комментарии (дописывает хронологию ответов).
 */
export declare function syncAdminCommentNotification(bot: Bot, comment: Comment, postId: string, channelChatId: number): Promise<void>;
/**
 * Шлёт пользователю DM об ответе канала на комментарий (кнопка «Открыть»). Ошибки доставки логируются.
 */
export declare function notifyUserAboutMiniappReply(bot: Bot, input: {
    userId: number;
    commentId: string;
    postText: string;
    userCommentText: string;
    adminReplyText: string;
    adminReplyPhotoUrls?: string[];
    postId: string;
    channelChatId: number;
}): Promise<void>;
