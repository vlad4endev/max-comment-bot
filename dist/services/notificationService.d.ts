import type { Bot } from '@maxhub/max-bot-api';
/** Доп. параметры отправки сообщения (клавиатура и т.д.), как у `bot.api.sendMessageToUser`. */
export type SendMessageExtra = NonNullable<Parameters<Bot['api']['sendMessageToUser']>[2]>;
/**
 * Возвращает user_id админов и владельцев чата (роли в API: {@link ChatMember.is_admin} / {@link ChatMember.is_owner}).
 * Вызывает {@link Bot.api.getChatAdmins} → `GET chats/{chat_id}/members/admins`.
 */
export declare function getChannelAdmins(bot: Bot, chatId: number): Promise<number[]>;
/**
 * Уведомляет всех админов канала личными сообщениями; для `ADMIN_CHAT_ID` используется `sendMessageToChat` (супер-админ / группа).
 */
export declare function notifyAllAdmins(bot: Bot, chatId: number, message: string, extra?: SendMessageExtra): Promise<void>;
/**
 * Уведомляет админов канала о новом комментарии из Mini App (текст + ссылка на приложение с admin=1).
 */
export declare function notifyAdminsNewMiniappComment(bot: Bot, input: {
    channelChatId: number;
    postText: string;
    channelTitle: string;
    username: string;
    commentText: string;
    postId: string;
}): Promise<void>;
/**
 * Шлёт пользователю DM об ответе канала на комментарий (кнопка «Открыть»). Ошибки доставки логируются.
 */
export declare function notifyUserAboutMiniappReply(bot: Bot, input: {
    userId: number;
    postText: string;
    userCommentText: string;
    adminReplyText: string;
    postId: string;
    channelChatId: number;
}): Promise<void>;
