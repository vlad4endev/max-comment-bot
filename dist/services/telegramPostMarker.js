"use strict";
/**
 * Маркировка TG-постов при кросс-платформенной брони комментариев.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyTelegramPostBookingMarker = applyTelegramPostBookingMarker;
const axios_1 = __importDefault(require("axios"));
const adminPanelState_1 = require("../api/adminPanelState");
const commentSyncFilter_1 = require("../utils/commentSyncFilter");
const logger_1 = require("../utils/logger");
const postCommentMappingStore_1 = require("./postCommentMappingStore");
const postStore_1 = require("./postStore");
const telegramDiscussionThreadResolver_1 = require("./telegramDiscussionThreadResolver");
const resolveTelegramBotToken_1 = require("./resolveTelegramBotToken");
const TG_API = 'https://api.telegram.org';
function resolveTelegramBotTokenForChain(chainId) {
    const chain = (0, adminPanelState_1.listTgChainsSync)().find((c) => c.id === chainId);
    const fromChain = chain?.bot_token?.trim();
    if (fromChain)
        return fromChain;
    return (0, resolveTelegramBotToken_1.resolveTelegramBotToken)();
}
function isCommentForwardEnabled(chainId) {
    const chain = (0, adminPanelState_1.listTgChainsSync)().find((c) => c.id === chainId);
    return chain?.active !== false && chain?.forward_comments === true;
}
function resolvePostThreadTargetFromMapping(mapping) {
    if (!mapping.tg_thread_chat_id || !mapping.tg_thread_msg_id)
        return null;
    if (!isCommentForwardEnabled(mapping.chain_id))
        return null;
    const token = resolveTelegramBotTokenForChain(mapping.chain_id);
    if (!token)
        return null;
    return {
        token,
        threadChatId: mapping.tg_thread_chat_id,
        threadMsgId: mapping.tg_thread_msg_id,
    };
}
async function resolvePostThreadTarget(messageMid) {
    await (0, telegramDiscussionThreadResolver_1.ensurePostThreadMapping)(messageMid);
    const mapping = (0, postCommentMappingStore_1.findMappingByMaxMid)(messageMid);
    if (!mapping)
        return null;
    return resolvePostThreadTargetFromMapping(mapping);
}
function tgPayload(target, body) {
    const payload = {
        chat_id: target.chatId,
        message_id: target.messageId,
        ...body,
    };
    if (typeof target.messageThreadId === 'number' && target.messageThreadId > 0) {
        payload.message_thread_id = target.messageThreadId;
    }
    return payload;
}
async function tryEditTelegramPostBody(target, markedText) {
    for (const method of ['editMessageCaption', 'editMessageText']) {
        const bodyKey = method === 'editMessageCaption' ? 'caption' : 'text';
        try {
            const { data } = await axios_1.default.post(`${TG_API}/bot${target.token}/${method}`, tgPayload(target, { [bodyKey]: markedText }), { timeout: 15_000 });
            if (data.ok)
                return true;
        }
        catch {
            // try next method
        }
    }
    return false;
}
/** Дописывает маркер брони к TG-посту (канал + тред обсуждения). */
async function applyTelegramPostBookingMarker(post, marker) {
    const freshPost = postStore_1.postStore.getPost(post.post_id) ?? post;
    const baseText = freshPost.text?.trim() || '';
    if (!baseText) {
        logger_1.logger.warn('[telegramPostMarker] empty post text for booked marker', {
            postId: freshPost.post_id,
        });
        return false;
    }
    if (baseText.includes(marker)) {
        if (marker.includes('МАКС')) {
            postStore_1.postStore.markTgBookedInMaxApplied(freshPost.post_id);
        }
        return true;
    }
    const markedText = (0, commentSyncFilter_1.appendBookingMarker)(baseText, marker);
    const target = await resolvePostThreadTarget(freshPost.message_mid);
    if (!target) {
        logger_1.logger.warn('[telegramPostMarker] no thread target for booking marker', {
            postId: freshPost.post_id,
            messageMid: freshPost.message_mid,
        });
        return false;
    }
    const mapping = (0, postCommentMappingStore_1.findMappingByMaxMid)(freshPost.message_mid);
    const editTargets = [];
    if (typeof mapping?.tg_chat_id === 'number' && mapping.tg_msg_id > 0) {
        editTargets.push({
            token: target.token,
            chatId: mapping.tg_chat_id,
            messageId: mapping.tg_msg_id,
        });
    }
    editTargets.push({
        token: target.token,
        chatId: target.threadChatId,
        messageId: target.threadMsgId,
        messageThreadId: target.threadMsgId,
    });
    for (const editTarget of editTargets) {
        if (await tryEditTelegramPostBody(editTarget, markedText)) {
            if (marker.includes('МАКС')) {
                postStore_1.postStore.markTgBookedInMaxApplied(freshPost.post_id);
            }
            logger_1.logger.info('[telegramPostMarker] appended booking marker to TG post', {
                postId: freshPost.post_id,
                chatId: editTarget.chatId,
                messageId: editTarget.messageId,
                marker,
            });
            return true;
        }
    }
    logger_1.logger.warn('[telegramPostMarker] failed to append booking marker', {
        postId: freshPost.post_id,
        marker,
    });
    return false;
}
//# sourceMappingURL=telegramPostMarker.js.map