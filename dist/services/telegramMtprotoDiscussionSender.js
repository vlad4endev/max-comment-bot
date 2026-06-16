"use strict";
/**
 * Отправка комментариев в TG-обсуждение от имени канала или чата (sendAs).
 * Bot API не умеет публиковать от канала/чата — только MTProto user-сессия.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.mtprotoDiscussionSenderConfigured = mtprotoDiscussionSenderConfigured;
exports.sendDiscussionMessageAsPeer = sendDiscussionMessageAsPeer;
exports.sendDiscussionMessageAsChannel = sendDiscussionMessageAsChannel;
const telegram_1 = require("telegram");
const Helpers_1 = require("telegram/Helpers");
const logger_1 = require("../utils/logger");
const telegramUserArchive_1 = require("./telegramUserArchive");
function mtprotoDiscussionSenderConfigured() {
    return (0, telegramUserArchive_1.telegramUserArchiveConfigured)();
}
function extractMessageIdFromUpdates(updates) {
    if (updates instanceof telegram_1.Api.UpdateShortSentMessage) {
        return updates.id;
    }
    if (updates instanceof telegram_1.Api.Updates || updates instanceof telegram_1.Api.UpdatesCombined) {
        for (const update of updates.updates) {
            if (update instanceof telegram_1.Api.UpdateNewMessage ||
                update instanceof telegram_1.Api.UpdateNewChannelMessage) {
                const msg = update.message;
                if (msg instanceof telegram_1.Api.Message && typeof msg.id === 'number') {
                    return msg.id;
                }
            }
        }
    }
    return null;
}
/**
 * Публикует сообщение в чат обсуждений от имени канала или самой группы обсуждений.
 *
 * - `channel` — подпись канала (как «ответ от канала» в комментариях)
 * - `chat` — от имени группы обсуждений (как «анонимный админ» в TG)
 */
async function sendDiscussionMessageAsPeer(mode, discussionChatId, channelKey, text, replyToMessageId) {
    if (!(0, telegramUserArchive_1.telegramUserArchiveConfigured)()) {
        return null;
    }
    const trimmed = text.trim();
    if (!trimmed) {
        return null;
    }
    const client = await (0, telegramUserArchive_1.connectTelegramUserClient)();
    try {
        const discussionPeer = await client.getInputEntity(discussionChatId);
        let sendAsPeer = discussionPeer;
        if (mode === 'channel') {
            if (!channelKey) {
                return null;
            }
            const channelEntity = await (0, telegramUserArchive_1.resolveTelegramChannelEntity)(client, channelKey);
            sendAsPeer = await client.getInputEntity(channelEntity);
        }
        const updates = await client.invoke(new telegram_1.Api.messages.SendMessage({
            peer: discussionPeer,
            message: trimmed,
            replyTo: new telegram_1.Api.InputReplyToMessage({ replyToMsgId: replyToMessageId }),
            randomId: (0, Helpers_1.generateRandomLong)(),
            sendAs: sendAsPeer,
        }));
        const messageId = extractMessageIdFromUpdates(updates);
        if (messageId != null) {
            logger_1.logger.info('[telegramMtprotoDiscussionSender] sent with sendAs', {
                mode,
                discussionChatId,
                channelKey,
                replyToMessageId,
                messageId,
            });
        }
        return messageId;
    }
    finally {
        await client.disconnect();
    }
}
/** @deprecated используйте sendDiscussionMessageAsPeer */
async function sendDiscussionMessageAsChannel(discussionChatId, channelKey, text, replyToMessageId) {
    return sendDiscussionMessageAsPeer('channel', discussionChatId, channelKey, text, replyToMessageId);
}
//# sourceMappingURL=telegramMtprotoDiscussionSender.js.map