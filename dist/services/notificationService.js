"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationService = void 0;
exports.createNotificationService = createNotificationService;
const max_bot_api_1 = require("@maxhub/max-bot-api");
const logger_1 = require("../utils/logger");
class NotificationService {
    bot;
    adminChatId;
    constructor(bot, adminChatId) {
        this.bot = bot;
        this.adminChatId = adminChatId;
    }
    /**
     * Произвольное текстовое сообщение в админский чат (системные уведомления).
     */
    async notifyAdmin(text) {
        try {
            await this.bot.api.sendMessageToChat(this.adminChatId, text);
            logger_1.logger.info('Админ-уведомление отправлено');
        }
        catch (err) {
            logger_1.logger.error('Не удалось отправить админ-уведомление', err);
        }
    }
    async notifyNewComment(data) {
        const { postId, userId, userName, text, sourceChatId } = data;
        const chatLine = sourceChatId !== undefined ? `\nЧат: ID ${sourceChatId}` : '';
        const message = `📝 Новый комментарий
Пост: #${postId}
От: ${userName} (ID: ${userId})${chatLine}
Текст:
${text}`;
        const keyboard = max_bot_api_1.Keyboard.inlineKeyboard([
            [max_bot_api_1.Keyboard.button.callback('✉️ Ответить', `reply_${userId}`)],
        ]);
        try {
            await this.bot.api.sendMessageToChat(this.adminChatId, message, {
                attachments: [keyboard],
            });
            logger_1.logger.info('Уведомление отправлено админу', { postId, userId, sourceChatId });
        }
        catch (err) {
            logger_1.logger.error('Не удалось отправить уведомление админу о новом комментарии', err);
        }
    }
    async notifyUserAboutReply(userId, replyText) {
        const message = `💬 На ваш комментарий ответили:\n\n"${replyText}"`;
        try {
            await this.bot.api.sendMessageToUser(userId, message);
            logger_1.logger.info('Пользователю отправлено уведомление об ответе', { userId });
        }
        catch (err) {
            logger_1.logger.error('Не удалось отправить пользователю уведомление об ответе', err);
        }
    }
}
exports.NotificationService = NotificationService;
function createNotificationService(bot, adminChatId) {
    return new NotificationService(bot, adminChatId);
}
//# sourceMappingURL=notificationService.js.map