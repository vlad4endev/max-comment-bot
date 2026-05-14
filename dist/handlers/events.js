"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerEventHandlers = registerEventHandlers;
const logger_1 = require("../utils/logger");
const stateManager_1 = require("../services/stateManager");
const commentService_1 = require("../services/commentService");
const notificationService_1 = require("../services/notificationService");
const deeplink_1 = require("../utils/deeplink");
const config_1 = require("../config");
function registerEventHandlers(bot) {
    const notificationService = (0, notificationService_1.createNotificationService)(bot, config_1.config.ADMIN_CHAT_ID);
    bot.on('bot_started', async (ctx) => {
        const user = ctx.user;
        if (!user) {
            return;
        }
        logger_1.logger.info(`bot_started: пользователь ${user.user_id}`);
        const payload = ctx.startPayload;
        if (payload) {
            const parsed = (0, deeplink_1.parsePayload)(payload);
            if (parsed?.type === 'post') {
                stateManager_1.stateManager.setState(user.user_id, {
                    mode: 'commenting',
                    postId: parsed.id,
                    createdAt: new Date(),
                });
                await ctx.reply('📝 Напишите ваш комментарий. Я передам его автору канала.');
                return;
            }
        }
        await ctx.reply('👋 Привет! Нажмите на кнопку под постом, чтобы оставить комментарий.');
    });
    bot.on('message_created', async (ctx) => {
        const message = ctx.message;
        if (!message) {
            return;
        }
        const user = message.sender;
        if (!user) {
            return;
        }
        logger_1.logger.info(`message_created: от ${user.user_id}`);
        const state = stateManager_1.stateManager.getState(user.user_id);
        const text = message.body.text || '';
        if (!state) {
            await ctx.reply('👋 Привет! Нажмите на кнопку под постом для комментария.');
            return;
        }
        if (state.mode === 'commenting' && state.postId) {
            await commentService_1.commentService.create({
                postId: state.postId,
                userId: user.user_id,
                userName: user.name || 'Пользователь',
                text,
            });
            await notificationService.notifyNewComment({
                postId: state.postId,
                userId: user.user_id,
                userName: user.name || 'Пользователь',
                text,
            });
            await ctx.reply('✅ Спасибо! Ваш комментарий отправлен на модерацию.');
            stateManager_1.stateManager.deleteState(user.user_id);
            return;
        }
        if (state.mode === 'replying' && state.replyToUserId) {
            const userId = state.replyToUserId;
            await notificationService.notifyUserAboutReply(userId, text);
            await ctx.reply('✅ Ответ отправлен пользователю.');
            stateManager_1.stateManager.deleteState(user.user_id);
            return;
        }
    });
    bot.on('message_callback', async (ctx) => {
        const user = ctx.user;
        if (!user) {
            return;
        }
        const callbackData = ctx.callback?.payload;
        logger_1.logger.info(`message_callback: payload=${callbackData}`);
        if (callbackData?.startsWith('reply_')) {
            const userIdStr = callbackData.replace('reply_', '');
            const userId = parseInt(userIdStr, 10);
            stateManager_1.stateManager.setState(user.user_id, {
                mode: 'replying',
                replyToUserId: userId,
                createdAt: new Date(),
            });
            await ctx.reply('📝 Напишите ответ на комментарий.');
        }
    });
    logger_1.logger.info('✅ Обработчики событий зарегистрированы');
}
//# sourceMappingURL=events.js.map