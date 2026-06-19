"use strict";
/**
 * Кросс-платформенная бронь поста: при первом комментарии на одной платформе
 * помечаем пост на MAX, Telegram и VK.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.claimAndPropagateCommentsBooking = claimAndPropagateCommentsBooking;
exports.propagateCommentsBooking = propagateCommentsBooking;
exports.isCommentSyncBlockedByBooking = isCommentSyncBlockedByBooking;
exports.commentsClosedInMaxMessage = commentsClosedInMaxMessage;
const adminPanelState_1 = require("../api/adminPanelState");
const commentSyncFilter_1 = require("../utils/commentSyncFilter");
const logger_1 = require("../utils/logger");
const integrationPlatformClient_1 = require("./integrationPlatformClient");
const postStore_1 = require("./postStore");
const telegramPostMarker_1 = require("./telegramPostMarker");
const vkPostMappingStore_1 = require("./vkPostMappingStore");
async function claimAndPropagateCommentsBooking(postId, by, bot) {
    const claimed = postStore_1.postStore.tryClaimCommentsBooking(postId, by);
    if (!claimed) {
        return false;
    }
    await propagateCommentsBooking(postId, by, bot);
    return true;
}
async function propagateCommentsBooking(postId, bookedBy, bot) {
    const post = postStore_1.postStore.getPost(postId);
    if (!post) {
        return;
    }
    const tasks = [];
    if (bookedBy === 'telegram' || bookedBy === 'vk') {
        if (bot) {
            tasks.push(postStore_1.postStore
                .updateButtonCaption(bot, post)
                .then(() => undefined)
                .catch((err) => {
                logger_1.logger.warn('[commentsBooking] MAX button update failed', { postId, bookedBy, err });
            }));
        }
    }
    const tgMarker = (0, commentSyncFilter_1.bookingMarkerForTelegram)(bookedBy);
    if (tgMarker) {
        tasks.push((0, telegramPostMarker_1.applyTelegramPostBookingMarker)(post, tgMarker)
            .then(() => undefined)
            .catch((err) => {
            logger_1.logger.warn('[commentsBooking] TG marker failed', { postId, bookedBy, err });
        }));
    }
    tasks.push(applyVkPostBookingMarkers(post, bookedBy));
    await Promise.all(tasks);
}
async function applyVkPostBookingMarkers(post, bookedBy) {
    const marker = (0, commentSyncFilter_1.bookingMarkerForVk)(bookedBy);
    if (!marker) {
        return;
    }
    await vkPostMappingStore_1.vkPostMappingStore.load().catch(() => undefined);
    const chains = (0, adminPanelState_1.listVkChainsSync)().filter((c) => c.active);
    const seen = new Set();
    for (const chain of chains) {
        if (Math.abs(chain.max_chat_id) !== Math.abs(post.chat_id))
            continue;
        for (const mapping of vkPostMappingStore_1.vkPostMappingStore.listByChain(chain.id)) {
            if (mapping.maxMid !== post.message_mid)
                continue;
            const key = `${chain.id}:${mapping.vkPostId}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            const ok = await (0, integrationPlatformClient_1.appendMarkerToVkWallPost)(chain.vk_token, chain.vk_group_id, mapping.vkPostId, marker);
            if (ok) {
                logger_1.logger.info('[commentsBooking] VK post marked', {
                    postId: post.post_id,
                    bookedBy,
                    vkPostId: mapping.vkPostId,
                    groupId: chain.vk_group_id,
                });
            }
            else {
                logger_1.logger.warn('[commentsBooking] VK post marker failed', {
                    postId: post.post_id,
                    bookedBy,
                    vkPostId: mapping.vkPostId,
                    groupId: chain.vk_group_id,
                });
            }
        }
    }
}
/** Можно ли синхронизировать комментарии с платформы `from`, если пост забронирован другой платформой. */
function isCommentSyncBlockedByBooking(bookedBy, from) {
    if (!bookedBy || bookedBy === from) {
        return false;
    }
    return true;
}
function commentsClosedInMaxMessage(bookedBy) {
    if (bookedBy === 'telegram') {
        return 'Комментарии закрыты. Обсуждение ведётся в Telegram.';
    }
    if (bookedBy === 'vk') {
        return 'Комментарии закрыты. Обсуждение ведётся во ВКонтакте.';
    }
    return 'Комментарии закрыты.';
}
//# sourceMappingURL=commentsBookingService.js.map