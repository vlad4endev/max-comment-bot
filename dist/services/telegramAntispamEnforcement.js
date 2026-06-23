"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TG_ANTISPAM_BAN_MUTE_SECONDS = exports.TG_ANTISPAM_MUTE_SECONDS = void 0;
exports.enforceTelegramAntispamAction = enforceTelegramAntispamAction;
const adminPanelState_1 = require("../api/adminPanelState");
const telegramRateLimiter_1 = require("../utils/telegramRateLimiter");
const logger_1 = require("../utils/logger");
/** Ограничение на время после обычного спама (удаление / флуд). */
exports.TG_ANTISPAM_MUTE_SECONDS = 3600;
/** Ограничение после бана (delete_and_ban, blacklist). */
exports.TG_ANTISPAM_BAN_MUTE_SECONDS = 86_400;
const MUTE_PERMISSIONS = {
    can_send_messages: false,
    can_send_audios: false,
    can_send_documents: false,
    can_send_photos: false,
    can_send_videos: false,
    can_send_video_notes: false,
    can_send_voice_notes: false,
    can_send_polls: false,
    can_send_other_messages: false,
    can_add_web_page_previews: false,
    can_change_info: false,
    can_invite_users: false,
    can_pin_messages: false,
    can_manage_topics: false,
};
function shouldDeleteMessage(evaluation) {
    if (evaluation.outcome === 'block' || evaluation.outcome === 'ban') {
        return true;
    }
    const action = evaluation.action;
    return action === 'delete' || action === 'captcha' || action === 'delete_and_ban';
}
function shouldRestrictUser(evaluation, autoMute) {
    if (!autoMute) {
        return false;
    }
    if (evaluation.outcome === 'ban') {
        return true;
    }
    return evaluation.action === 'delete_and_ban';
}
function muteDurationSeconds(evaluation) {
    if (evaluation.outcome === 'ban' || evaluation.action === 'delete_and_ban') {
        return exports.TG_ANTISPAM_BAN_MUTE_SECONDS;
    }
    return exports.TG_ANTISPAM_MUTE_SECONDS;
}
async function deleteTelegramMessage(token, chatId, messageId) {
    const data = await (0, telegramRateLimiter_1.callTelegramBotApi)(token, 'deleteMessage', { chat_id: chatId, message_id: messageId }, { method: 'deleteMessage', chatId });
    if (!data.ok) {
        logger_1.logger.warn('[antispam/tg] deleteMessage failed', {
            chatId,
            messageId,
            description: data.description ?? null,
        });
        return false;
    }
    return true;
}
async function restrictTelegramUser(token, chatId, userId, durationSeconds) {
    const untilDate = Math.floor(Date.now() / 1000) + durationSeconds;
    const data = await (0, telegramRateLimiter_1.callTelegramBotApi)(token, 'restrictChatMember', {
        chat_id: chatId,
        user_id: userId,
        permissions: MUTE_PERMISSIONS,
        until_date: untilDate,
    }, { method: 'restrictChatMember', chatId });
    if (!data.ok) {
        logger_1.logger.warn('[antispam/tg] restrictChatMember failed', {
            chatId,
            userId,
            untilDate,
            description: data.description ?? null,
        });
        return false;
    }
    return true;
}
/**
 * Удаляет спам-сообщение в TG-обсуждении и при необходимости ограничивает автора.
 */
async function enforceTelegramAntispamAction(input) {
    const { token, chatId, messageId, telegramUserId, channelChatId, evaluation } = input;
    const extras = (0, adminPanelState_1.getChannelExtrasSync)(channelChatId);
    let deleted = false;
    let restricted = false;
    if (shouldDeleteMessage(evaluation)) {
        deleted = await deleteTelegramMessage(token, chatId, messageId);
    }
    const restrict = shouldRestrictUser(evaluation, extras.auto_mute);
    if (restrict && telegramUserId != null && telegramUserId > 0) {
        const duration = muteDurationSeconds(evaluation);
        restricted = await restrictTelegramUser(token, chatId, telegramUserId, duration);
        if (restricted) {
            try {
                await (0, adminPanelState_1.restrictAntispamUser)(telegramUserId);
            }
            catch (err) {
                logger_1.logger.warn('[antispam/tg] restrictAntispamUser db failed', { telegramUserId, err });
            }
        }
    }
    logger_1.logger.info('[antispam/tg] enforced', {
        chatId,
        messageId,
        telegramUserId,
        channelChatId,
        outcome: evaluation.outcome,
        action: evaluation.action,
        spamScore: evaluation.spamScore,
        deleted,
        restricted,
        autoMute: extras.auto_mute,
    });
    return { deleted, restricted };
}
//# sourceMappingURL=telegramAntispamEnforcement.js.map