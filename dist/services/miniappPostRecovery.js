"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recoverPostByPostIdInChannelFeed = recoverPostByPostIdInChannelFeed;
const channelPostActions_1 = require("./channelPostActions");
const channelPoller_1 = require("./channelPoller");
const resolveChannelChatId_1 = require("./resolveChannelChatId");
const logger_1 = require("../utils/logger");
const startappPayload_1 = require("../utils/startappPayload");
const postStore_1 = require("./postStore");
const RECOVERY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const RECOVERY_MAX_PAGES = 12;
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
function messageMidMatchesPostId(message, postId) {
    const mid = message.body?.mid?.trim();
    if (!mid) {
        return false;
    }
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
 * Orphan Mini App link: `post_id` on the button, no row in SQLite — scan recent channel feed for matching keyboard.
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
        const messageMid = message.body?.mid?.trim();
        if (!messageMid) {
            continue;
        }
        const row = postStore_1.postStore.findPostByChannelMessage(canonical, messageMid);
        if (row) {
            logger_1.logger.info('miniappPostRecovery: post row already exists for scanned message_mid', {
                requestedPostId: id,
                postId: row.post_id,
                chatId: canonical,
                messageMid,
            });
            return row;
        }
        const restored = await (0, channelPostActions_1.ensurePostFromChannelMessage)(bot, canonical, messageMid);
        if (restored) {
            logger_1.logger.info('miniappPostRecovery: restored post from channel feed scan', {
                requestedPostId: id,
                postId: restored.post_id,
                chatId: canonical,
                messageMid,
            });
            return restored;
        }
    }
    logger_1.logger.warn('miniappPostRecovery: no channel message with matching button post_id', {
        chatId: canonical,
        postId: id,
        messagesScanned: messages.length,
    });
    return null;
}
//# sourceMappingURL=miniappPostRecovery.js.map