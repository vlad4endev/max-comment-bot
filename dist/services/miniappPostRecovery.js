"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.postIdsMatch = postIdsMatch;
exports.extractStartappFromMessage = extractStartappFromMessage;
exports.resolveChannelMessageMid = resolveChannelMessageMid;
exports.recoverPostByPostIdInChannelFeed = recoverPostByPostIdInChannelFeed;
exports.resolveMiniappPostOpen = resolveMiniappPostOpen;
const channelPostActions_1 = require("./channelPostActions");
const channelPoller_1 = require("./channelPoller");
const resolveChannelChatId_1 = require("./resolveChannelChatId");
const logger_1 = require("../utils/logger");
const startappPayload_1 = require("../utils/startappPayload");
const postStore_1 = require("./postStore");
const RECOVERY_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const RECOVERY_MAX_PAGES = 25;
const MINIAPP_LOOKUP_RETRY_MS = 2000;
function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function postIdsMatch(requested, fromPayload) {
    const a = requested.trim().toLowerCase();
    const b = fromPayload.trim().toLowerCase();
    if (a === b) {
        return true;
    }
    return a.replace(/-/g, '') === b.replace(/-/g, '');
}
function collectUrlStrings(value, out) {
    if (typeof value === 'string') {
        if (value.includes('startapp=') || value.includes('pid_')) {
            out.push(value);
        }
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            collectUrlStrings(item, out);
        }
        return;
    }
    if (typeof value === 'object' && value !== null) {
        for (const v of Object.values(value)) {
            collectUrlStrings(v, out);
        }
    }
}
function extractStartappFromMessage(message) {
    const urls = [];
    for (const att of message.body.attachments ?? []) {
        collectUrlStrings(att, urls);
    }
    for (const raw of urls) {
        try {
            const sp = new URL(raw).searchParams.get('startapp');
            if (sp?.trim()) {
                return sp.trim();
            }
        }
        catch {
            const m = /startapp=([^&]+)/i.exec(raw);
            if (m?.[1]) {
                return decodeURIComponent(m[1]);
            }
        }
        const direct = raw.trim();
        if (/^pid_/i.test(direct)) {
            return direct;
        }
    }
    return null;
}
/** Channel post `message_mid` (for reply UI stubs — the linked parent post). */
function resolveChannelMessageMid(message) {
    const bodyMid = message.body?.mid?.trim();
    if (!bodyMid) {
        return null;
    }
    const link = message.link;
    if (link?.type === 'reply' && typeof link.mid === 'string' && link.mid.trim() !== '') {
        return link.mid.trim();
    }
    return bodyMid;
}
function messageMidMatchesPostId(message, postId) {
    const startapp = extractStartappFromMessage(message);
    if (!startapp) {
        return false;
    }
    const parsed = (0, startappPayload_1.parseStartappPayload)(startapp);
    if (!parsed?.post_id) {
        return false;
    }
    return postIdsMatch(postId, parsed.post_id);
}
/**
 * Orphan Mini App link: `post_id` on the button, no row in SQLite — scan channel feed, register row, fix button.
 */
async function recoverPostByPostIdInChannelFeed(bot, chatId, postId) {
    const id = postId.trim();
    if (!id) {
        return null;
    }
    const canonical = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(chatId) ?? chatId;
    const existing = postStore_1.postStore.getPost(id);
    if (existing) {
        return existing;
    }
    const cutoffMs = Date.now() - RECOVERY_LOOKBACK_MS;
    let messages = [];
    try {
        messages = await (0, channelPoller_1.fetchChannelMessagesSince)(bot, canonical, cutoffMs, {
            maxPages: RECOVERY_MAX_PAGES,
        });
    }
    catch (err) {
        logger_1.logger.warn('miniappPostRecovery: getMessages failed', { chatId: canonical, postId: id, err });
        return null;
    }
    for (const message of messages) {
        if (!messageMidMatchesPostId(message, id)) {
            continue;
        }
        const channelMid = resolveChannelMessageMid(message);
        if (!channelMid) {
            continue;
        }
        const row = postStore_1.postStore.findPostByChannelMessage(canonical, channelMid);
        if (row) {
            logger_1.logger.info('miniappPostRecovery: matched button on channel feed (row exists)', {
                requestedPostId: id,
                postId: row.post_id,
                chatId: canonical,
                messageMid: channelMid,
            });
            if (!postIdsMatch(id, row.post_id)) {
                const fixed = await (0, channelPostActions_1.ensurePostFromChannelMessage)(bot, canonical, channelMid, {
                    reattachButton: true,
                });
                return fixed ?? row;
            }
            return row;
        }
        const restored = await (0, channelPostActions_1.ensurePostFromChannelMessage)(bot, canonical, channelMid, {
            preferredPostId: id,
            reattachButton: true,
        });
        if (restored) {
            logger_1.logger.info('miniappPostRecovery: restored post from channel feed scan', {
                requestedPostId: id,
                postId: restored.post_id,
                chatId: canonical,
                messageMid: channelMid,
            });
            return restored;
        }
    }
    logger_1.logger.warn('miniappPostRecovery: no channel message with matching button post_id', {
        chatId: canonical,
        postId: id,
        messagesScanned: messages.length,
        lookbackDays: Math.round(RECOVERY_LOOKBACK_MS / (24 * 60 * 60 * 1000)),
    });
    return null;
}
/**
 * Resolves a post for Mini App open: DB → retry → ensure by mid → scan channel feed by orphan `post_id`.
 */
async function resolveMiniappPostOpen(bot, lookup, resolveFromDb) {
    let post = resolveFromDb(lookup.postId, lookup.chatIdRaw, lookup.messageMid);
    if (post) {
        return post;
    }
    await sleepMs(MINIAPP_LOOKUP_RETRY_MS);
    post = resolveFromDb(lookup.postId, lookup.chatIdRaw, lookup.messageMid);
    if (post) {
        logger_1.logger.info('resolveMiniappPostOpen: post found after retry', {
            postId: lookup.postId,
            chatId: lookup.chatIdRaw,
            messageMid: lookup.messageMid,
        });
        return post;
    }
    const mid = lookup.messageMid?.trim() ?? '';
    const postId = lookup.postId.trim();
    if (mid !== '') {
        const canonicalChatId = lookup.chatIdRaw !== null
            ? ((0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(lookup.chatIdRaw) ?? lookup.chatIdRaw)
            : null;
        if (canonicalChatId !== null) {
            post = await (0, channelPostActions_1.ensurePostFromChannelMessage)(bot, canonicalChatId, mid, {
                preferredPostId: postId || undefined,
                reattachButton: true,
            });
        }
        else {
            post = postStore_1.postStore.findByMessageMid(mid);
        }
        if (post) {
            if (postId && post.post_id !== postId) {
                logger_1.logger.info('resolveMiniappPostOpen: resolved by message_mid (post_id differs from link)', {
                    requestedPostId: postId,
                    postId: post.post_id,
                    messageMid: mid,
                });
            }
            return post;
        }
    }
    if (postId !== '' && lookup.chatIdRaw !== null) {
        post = await recoverPostByPostIdInChannelFeed(bot, lookup.chatIdRaw, postId);
    }
    return post;
}
//# sourceMappingURL=miniappPostRecovery.js.map