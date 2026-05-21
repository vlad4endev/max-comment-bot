"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.notifyTelegramAdminsNewMiniappComment = notifyTelegramAdminsNewMiniappComment;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
const integrationsStore_1 = require("./integrationsStore");
const integrationPlatformClient_1 = require("./integrationPlatformClient");
const telegramMiniappAuth_1 = require("./telegramMiniappAuth");
const TG_API = 'https://api.telegram.org';
function preview80(text) {
    const t = text.trim().replace(/\s+/g, ' ');
    if (t.length <= 80) {
        return t;
    }
    return `${t.slice(0, 80)}…`;
}
function resolveTelegramSourceChannelsForMaxChat(maxChatId) {
    const targetAbs = Math.abs(maxChatId);
    const out = new Set();
    for (const flow of integrationsStore_1.integrationsStore.getFlows()) {
        if (!flow.enabled) {
            continue;
        }
        if (flow.source.platform !== 'telegram' || flow.destination.platform !== 'max') {
            continue;
        }
        const dest = Number.parseInt(flow.destination.channelId, 10);
        if (!Number.isFinite(dest) || Math.abs(dest) !== targetAbs) {
            continue;
        }
        const sourceChannel = flow.source.channelId?.trim() || flow.source.channelUsername?.trim() || '';
        if (sourceChannel !== '') {
            out.add(sourceChannel);
        }
    }
    return [...out];
}
async function tgSendMessage(token, chatId, text, buttonUrl) {
    await axios_1.default.post(`${TG_API}/bot${token}/sendMessage`, {
        chat_id: chatId,
        text,
        reply_markup: {
            inline_keyboard: [
                [{ text: '💬 Открыть комментарии', url: buttonUrl }],
            ],
        },
    }, { timeout: 20_000 });
}
async function notifyTelegramAdminsNewMiniappComment(input) {
    await integrationsStore_1.integrationsStore.load();
    const token = (0, config_1.getTelegramToken)();
    if (!token) {
        return;
    }
    const targetChannels = resolveTelegramSourceChannelsForMaxChat(input.maxChannelChatId);
    if (targetChannels.length === 0) {
        return;
    }
    const postExcerpt = preview80(input.postText);
    const textPart = input.commentText.trim();
    const photoCount = Array.isArray(input.commentPhotoUrls) ? input.commentPhotoUrls.length : 0;
    const commentPreview = textPart !== ''
        ? textPart
        : photoCount > 0
            ? `📷 Фото: ${photoCount}`
            : 'без текста';
    const photoSuffix = photoCount > 0 ? `\n📷 Фото: ${photoCount}` : '';
    const message = `📌 Новый комментарий
Пост: «${postExcerpt}»
Канал: ${input.channelTitle}
👤 ${input.username}: ${commentPreview}${photoSuffix}`;
    for (const tgChannelId of targetChannels) {
        const admins = await (0, integrationPlatformClient_1.listTelegramChatAdministrators)(token, tgChannelId);
        const recipients = admins.filter((a) => a.startedBot).map((a) => a.userId);
        for (const recipientId of recipients) {
            const url = (0, telegramMiniappAuth_1.buildTelegramMiniappUrl)({
                postId: input.postId,
                maxChatId: input.maxChannelChatId,
                messageMid: input.messageMid,
                telegramUserId: recipientId,
            });
            if (!url) {
                logger_1.logger.warn('notifyTelegramAdminsNewMiniappComment: MINI_APP_URL не задан, TG-кнопка пропущена', {
                    commentId: input.commentId,
                    recipientId,
                });
                continue;
            }
            try {
                await tgSendMessage(token, recipientId, message, url);
            }
            catch (err) {
                logger_1.logger.warn('notifyTelegramAdminsNewMiniappComment: sendMessage failed', {
                    commentId: input.commentId,
                    recipientId,
                    tgChannelId,
                    err,
                });
            }
        }
    }
}
//# sourceMappingURL=telegramAdminNotificationService.js.map