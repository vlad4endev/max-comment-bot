"use strict";
/**
 * vkChainForwarder.ts
 *
 * Сервис для связки MAX-канала с VK-сообществом:
 * 1. Публикует посты из MAX в VK (вызывается хуком из tgChainForwarder).
 * 2. Опрашивает комментарии VK и синхронизирует их в MAX miniapp.
 * 3. Отправляет новые комментарии из MAX miniapp в VK.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.setVkChainForwarderBot = setVkChainForwarderBot;
exports.onMaxPostPublished = onMaxPostPublished;
exports.startVkChainForwarder = startVkChainForwarder;
exports.stopVkChainForwarder = stopVkChainForwarder;
const adminPanelState_1 = require("../api/adminPanelState");
const antispamService_1 = require("./antispamService");
const commentStore_1 = require("./commentStore");
const postStore_1 = require("./postStore");
const resolveChannelChatId_1 = require("./resolveChannelChatId");
const integrationPlatformClient_1 = require("./integrationPlatformClient");
const vkPostMappingStore_1 = require("./vkPostMappingStore");
const commentSyncGuard_1 = require("../utils/commentSyncGuard");
const logger_1 = require("../utils/logger");
const VK_COMMENT_POLL_INTERVAL_MS = 30_000;
const VK_MAX_TO_VK_SYNC_INTERVAL_MS = 20_000;
/** Не опрашивать VK-пост старше 30 дней */
const VK_POST_MAX_AGE_DAYS = 30;
/** Формат имени VK-пользователя в miniapp */
const VK_USER_PREFIX = 'vk:';
let botRef = null;
let commentPollTimer = null;
let maxToVkSyncTimer = null;
let started = false;
function setVkChainForwarderBot(bot) {
    botRef = bot;
}
// ── Публикация поста MAX → VK ────────────────────────────────────────────────
/**
 * Хук, вызываемый из tgChainForwarder после того, как пост опубликован в MAX-канале.
 * Для всех активных VK-связок этого канала публикует тот же текст в VK.
 */
async function onMaxPostPublished(maxChatId, maxMid, postText) {
    const canonicalChatId = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(maxChatId) ?? maxChatId;
    const chains = (0, adminPanelState_1.listVkChainsSync)().filter((c) => c.active &&
        c.forward_posts &&
        (Math.abs(c.max_chat_id) === Math.abs(canonicalChatId) ||
            Math.abs(c.max_chat_id) === Math.abs(maxChatId)));
    if (chains.length === 0)
        return;
    for (const chain of chains) {
        await publishPostToVkChain(chain, maxMid, postText);
    }
}
async function publishPostToVkChain(chain, maxMid, postText) {
    try {
        const message = postText.trim() || '\u00a0';
        const vkPostId = await (0, integrationPlatformClient_1.publishVkWallPost)(chain.vk_token, chain.vk_group_id, message);
        if (vkPostId == null) {
            logger_1.logger.warn('[vkChain] publishVkWallPost returned null', {
                chainId: chain.id,
                maxMid,
            });
            return;
        }
        await vkPostMappingStore_1.vkPostMappingStore.upsert({
            chainId: chain.id,
            maxChatId: chain.max_chat_id,
            maxMid,
            vkPostId,
            vkGroupId: chain.vk_group_id,
            lastVkCommentId: 0,
        });
        await (0, adminPanelState_1.updateVkChain)(chain.id, {
            forwarded_today: (chain.forwarded_today ?? 0) + 1,
        });
        logger_1.logger.info('[vkChain] post published to VK', {
            chainId: chain.id,
            maxMid,
            vkPostId,
            groupId: chain.vk_group_id,
        });
    }
    catch (err) {
        await (0, adminPanelState_1.updateVkChain)(chain.id, {
            errors_today: (chain.errors_today ?? 0) + 1,
        });
        logger_1.logger.error('[vkChain] failed to publish post to VK', { chainId: chain.id, maxMid, err });
    }
}
// ── Синхронизация VK-комментариев → MAX miniapp ──────────────────────────────
async function syncVkCommentsForChain(chain) {
    if (!chain.sync_comments)
        return;
    const bot = botRef;
    const mappings = vkPostMappingStore_1.vkPostMappingStore.listByChain(chain.id);
    const cutoff = Date.now() - VK_POST_MAX_AGE_DAYS * 86_400_000;
    for (const mapping of mappings) {
        const createdAt = new Date(mapping.createdAt).getTime();
        if (Number.isFinite(createdAt) && createdAt < cutoff)
            continue;
        const post = postStore_1.postStore.findPostByChannelMessage(mapping.maxChatId, mapping.maxMid);
        if (!post)
            continue;
        const { comments, lastCommentId } = await (0, integrationPlatformClient_1.fetchVkWallComments)(chain.vk_token, chain.vk_group_id, mapping.vkPostId, mapping.lastVkCommentId);
        if (lastCommentId > mapping.lastVkCommentId) {
            await vkPostMappingStore_1.vkPostMappingStore.updateLastCommentId(chain.id, mapping.vkPostId, lastCommentId);
        }
        for (const vkComment of comments) {
            const guardKey = `vk:${chain.id}:${vkComment.id}`;
            if ((0, commentSyncGuard_1.isCommentSynced)(guardKey))
                continue;
            const existing = commentStore_1.commentStore
                .getComments(post.post_id)
                .find((c) => c.tg_comment_id === vkComment.id && c.source === 'telegram');
            if (existing) {
                (0, commentSyncGuard_1.markCommentSynced)(guardKey);
                continue;
            }
            const username = `${VK_USER_PREFIX}${vkComment.from_id}`;
            const antispam = (0, antispamService_1.evaluateComment)({
                text: vkComment.text,
                userId: vkComment.from_id,
                username,
                channelChatId: mapping.maxChatId,
                source: 'vk',
            });
            if (!antispam.allowed) {
                (0, commentSyncGuard_1.markCommentSynced)(guardKey);
                logger_1.logger.info('[vkChain] blocked VK comment by antispam', {
                    chainId: chain.id,
                    vkCommentId: vkComment.id,
                    spamScore: antispam.spamScore,
                    reason: antispam.reason,
                });
                continue;
            }
            const saved = commentStore_1.commentStore.saveTelegramThreadComment({
                post_id: post.post_id,
                user_id: vkComment.from_id,
                username,
                text: vkComment.text,
            }, vkComment.id);
            (0, commentSyncGuard_1.markCommentSynced)(guardKey);
            (0, commentSyncGuard_1.markCommentSynced)(`max:${saved.comment_id}`);
            const newCount = postStore_1.postStore.incrementCommentCount(post.post_id);
            if (newCount !== null && bot) {
                const updatedPost = postStore_1.postStore.getPost(post.post_id);
                if (updatedPost) {
                    await postStore_1.postStore.updateButtonCaption(bot, updatedPost).catch((err) => {
                        logger_1.logger.warn('[vkChain] updateButtonCaption failed', { commentId: saved.comment_id, err });
                    });
                }
            }
            logger_1.logger.info('[vkChain] synced VK comment to MAX miniapp', {
                chainId: chain.id,
                vkCommentId: vkComment.id,
                commentId: saved.comment_id,
                postId: post.post_id,
            });
        }
    }
}
async function syncAllVkCommentsToMax() {
    const chains = (0, adminPanelState_1.listVkChainsSync)().filter((c) => c.active && c.sync_comments);
    for (const chain of chains) {
        try {
            await syncVkCommentsForChain(chain);
        }
        catch (err) {
            logger_1.logger.error('[vkChain] syncVkCommentsForChain failed', { chainId: chain.id, err });
        }
    }
}
// ── Синхронизация MAX miniapp-комментариев → VK ──────────────────────────────
async function syncMaxCommentsToVk() {
    const chains = (0, adminPanelState_1.listVkChainsSync)().filter((c) => c.active && c.sync_comments);
    if (chains.length === 0)
        return;
    const pendingComments = commentStore_1.commentStore.listCommentsPendingMaxToTelegram(30);
    for (const comment of pendingComments) {
        const post = postStore_1.postStore.getPost(comment.post_id);
        if (!post)
            continue;
        for (const chain of chains) {
            if (Math.abs(chain.max_chat_id) !== Math.abs(post.chat_id))
                continue;
            const mapping = vkPostMappingStore_1.vkPostMappingStore
                .listByChain(chain.id)
                .find((m) => m.maxMid === post.message_mid);
            if (!mapping)
                continue;
            const guardKey = `vk-reply:${chain.id}:${comment.comment_id}`;
            if ((0, commentSyncGuard_1.isCommentSynced)(guardKey))
                continue;
            const commentText = comment.text?.trim();
            if (!commentText) {
                (0, commentSyncGuard_1.markCommentSynced)(guardKey);
                continue;
            }
            const vkCommentId = await (0, integrationPlatformClient_1.publishVkWallComment)(chain.vk_token, chain.vk_group_id, mapping.vkPostId, commentText);
            (0, commentSyncGuard_1.markCommentSynced)(guardKey);
            if (vkCommentId != null) {
                logger_1.logger.info('[vkChain] synced MAX comment to VK', {
                    chainId: chain.id,
                    commentId: comment.comment_id,
                    vkCommentId,
                    vkPostId: mapping.vkPostId,
                });
            }
        }
    }
}
// ── Запуск и остановка ───────────────────────────────────────────────────────
function startVkChainForwarder() {
    if (started)
        return;
    started = true;
    void vkPostMappingStore_1.vkPostMappingStore.load().catch((err) => {
        logger_1.logger.warn('[vkChain] mapping store load failed', err);
    });
    commentPollTimer = setInterval(() => {
        void syncAllVkCommentsToMax().catch((err) => {
            logger_1.logger.error('[vkChain] syncAllVkCommentsToMax error', err);
        });
    }, VK_COMMENT_POLL_INTERVAL_MS);
    maxToVkSyncTimer = setInterval(() => {
        void syncMaxCommentsToVk().catch((err) => {
            logger_1.logger.error('[vkChain] syncMaxCommentsToVk error', err);
        });
    }, VK_MAX_TO_VK_SYNC_INTERVAL_MS);
    const activeChains = (0, adminPanelState_1.listVkChainsSync)().filter((c) => c.active);
    logger_1.logger.info('[vkChain] started', {
        activeChains: activeChains.length,
        commentPollMs: VK_COMMENT_POLL_INTERVAL_MS,
        maxToVkMs: VK_MAX_TO_VK_SYNC_INTERVAL_MS,
    });
}
function stopVkChainForwarder() {
    if (commentPollTimer) {
        clearInterval(commentPollTimer);
        commentPollTimer = null;
    }
    if (maxToVkSyncTimer) {
        clearInterval(maxToVkSyncTimer);
        maxToVkSyncTimer = null;
    }
    started = false;
    logger_1.logger.info('[vkChain] stopped');
}
//# sourceMappingURL=vkChainForwarder.js.map