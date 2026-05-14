import type { Bot } from '@maxhub/max-bot-api';
export interface NotificationData {
    postId: string;
    userId: number;
    userName: string;
    text: string;
    /** Чат, откуда пришёл комментарий (для мульти-канального режима) */
    sourceChatId?: number;
}
export declare class NotificationService {
    private readonly bot;
    private readonly adminChatId;
    constructor(bot: Bot, adminChatId: number);
    /**
     * Произвольное текстовое сообщение в админский чат (системные уведомления).
     */
    notifyAdmin(text: string): Promise<void>;
    notifyNewComment(data: NotificationData): Promise<void>;
    notifyUserAboutReply(userId: number, replyText: string): Promise<void>;
}
export declare function createNotificationService(bot: Bot, adminChatId: number): NotificationService;
