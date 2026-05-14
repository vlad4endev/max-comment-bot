import type { Bot } from '@maxhub/max-bot-api';
export interface NotificationData {
    postId: string;
    userId: number;
    userName: string;
    text: string;
}
export declare class NotificationService {
    private readonly bot;
    private readonly adminChatId;
    constructor(bot: Bot, adminChatId: number);
    notifyNewComment(data: NotificationData): Promise<void>;
    notifyUserAboutReply(userId: number, replyText: string): Promise<void>;
}
export declare function createNotificationService(bot: Bot, adminChatId: number): NotificationService;
