"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyPostCommentButtonReady = verifyPostCommentButtonReady;
exports.rollbackFailedChannelPost = rollbackFailedChannelPost;
exports.attachAndVerifyCommentsForForwardedPost = attachAndVerifyCommentsForForwardedPost;
const channelPostActions_1 = require("./channelPostActions");
const resolveChannelChatId_1 = require("./resolveChannelChatId");
const logger_1 = require("../utils/logger");
const maxApiRetry_1 = require("../utils/maxApiRetry");
const postStore_1 = require("./postStore");
const GATE_VERIFY_ATTEMPTS = 5;
const GATE_VERIFY_DELAY_MS = 250;
function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function loadChannelMessage(bot, chatId, messageMid) {
    try {
        return await bot.api.getMessage(messageMid);
    }
    catch {
        try {
            const { messages } = await (0, maxApiRetry_1.apiCallWithRetry)(() => bot.api.getMessages(chatId, { message_ids: [messageMid] }));
            return messages[0] ?? null;
        }
        catch (err) {
            logger_1.logger.warn('channelPostPublishGate: could not load MAX message', {
                chatId,
                messageMid,
                err,
            });
            return null;
        }
    }
}
/** Post row exists, ids align, startapp has `_mid_`, button attach is not pending. */
function verifyPostCommentButtonReady(post) {
    const byId = postStore_1.postStore.getPost(post.post_id);
    if (!byId || byId.post_id !== post.post_id) {
        return false;
    }
    const byMid = postStore_1.postStore.findPostByChannelMessage(post.chat_id, post.message_mid);
    if (!byMid || byMid.post_id !== post.post_id) {
        return false;
    }
    if (byMid.button_attach_pending === true) {
        return false;
    }
    try {
        const url = (0, postStore_1.buildMiniAppUrl)(post.post_id, post.chat_id, undefined, post.message_mid);
        const startParam = new URL(url).searchParams.get('startapp') ?? '';
        if (!startParam.includes('_mid_')) {
            return false;
        }
    }
    catch {
        return false;
    }
    return postStore_1.postStore.findPost(post.post_id, post.chat_id) !== null;
}
function attachOutcomeOk(r) {
    return r.ok || r.reason === 'already_exists';
}
async function tryDeleteMaxMessage(bot, messageMid) {
    try {
        await (0, maxApiRetry_1.apiCallWithRetry)(() => bot.api.deleteMessage(messageMid));
    }
    catch (err) {
        logger_1.logger.warn('channelPostPublishGate: deleteMessage failed', { messageMid, err });
    }
}
/** Removes DB row(s) for this channel message and deletes MAX message(s) after a failed comment gate. */
async function rollbackFailedChannelPost(bot, chatId, messageMid, postIdHint, post) {
    const mid = messageMid.trim();
    const row = post ??
        postStore_1.postStore.findPostByChannelMessage(chatId, mid) ??
        (postIdHint?.trim() ? postStore_1.postStore.getPost(postIdHint.trim()) : null);
    if (row) {
        postStore_1.postStore.deletePostById(row.post_id);
    }
    else if (postIdHint?.trim()) {
        postStore_1.postStore.deletePostById(postIdHint.trim());
    }
    const mids = new Set();
    if (mid !== '') {
        mids.add(mid);
    }
    if (row?.comments_ui_message_mid?.trim()) {
        mids.add(row.comments_ui_message_mid.trim());
    }
    for (const m of mids) {
        await tryDeleteMaxMessage(bot, m);
    }
}
async function waitForVerifiedPost(chatId, messageMid, attachResult) {
    for (let attempt = 0; attempt < GATE_VERIFY_ATTEMPTS; attempt += 1) {
        if (attempt > 0) {
            await sleepMs(GATE_VERIFY_DELAY_MS * attempt);
        }
        const registered = postStore_1.postStore.findPostByChannelMessage(chatId, messageMid);
        if (registered !== null &&
            verifyPostCommentButtonReady(registered) &&
            attachOutcomeOk(attachResult)) {
            return registered;
        }
    }
    return postStore_1.postStore.findPostByChannelMessage(chatId, messageMid);
}
/**
 * After TG→MAX forward: attach button, verify Mini App lookup.
 * On failure deletes the MAX post and DB row so the TG message can be forwarded again.
 */
async function attachAndVerifyCommentsForForwardedPost(bot, maxChatId, maxMessageMid, context) {
    const chatId = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(maxChatId) ?? maxChatId;
    const mid = maxMessageMid.trim();
    if (mid === '') {
        return false;
    }
    const message = await loadChannelMessage(bot, chatId, mid);
    if (!message?.body?.mid) {
        await tryDeleteMaxMessage(bot, mid);
        return false;
    }
    const attachResult = await (0, channelPostActions_1.tryAttachCommentsToChannelPost)(bot, message, {
        channelChatIdOverride: chatId,
        skipAuthorAdminCheck: true,
        source: 'tg_chain',
        inlineOnly: true,
    });
    const registered = await waitForVerifiedPost(chatId, mid, attachResult);
    const ready = registered !== null && verifyPostCommentButtonReady(registered) && attachOutcomeOk(attachResult);
    if (ready) {
        logger_1.logger.info('[tgChain] comment gate ok', {
            chainId: context?.chainId,
            chatId,
            messageMid: mid,
            postId: registered.post_id,
            attachReason: attachResult.ok ? 'attached' : attachResult.reason,
        });
        return true;
    }
    logger_1.logger.warn('[tgChain] comment gate failed — rollback MAX post', {
        chainId: context?.chainId,
        chatId,
        messageMid: mid,
        attachReason: attachResult.ok ? 'attached' : attachResult.reason,
        hasRow: Boolean(registered),
        rowPostId: registered?.post_id,
        pending: registered?.button_attach_pending ?? null,
    });
    await rollbackFailedChannelPost(bot, chatId, mid, registered?.post_id, registered);
    return false;
}
//# sourceMappingURL=channelPostPublishGate.js.map