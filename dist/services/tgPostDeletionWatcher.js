"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDeletionWatcherStatus = getDeletionWatcherStatus;
exports.startTgPostDeletionWatcher = startTgPostDeletionWatcher;
exports.handleDeletedPost = handleDeletedPost;
const axios_1 = __importDefault(require("axios"));
const telegram_1 = require("telegram");
const events_1 = require("telegram/events");
const adminPanelState_1 = require("../api/adminPanelState");
const database_1 = require("../db/database");
const logger_1 = require("../utils/logger");
const maxApiRetry_1 = require("../utils/maxApiRetry");
const telegramUserArchive_1 = require("./telegramUserArchive");
const mtprotoConfigStore_1 = require("./mtprotoConfigStore");
const recentlyDeletedPosts = new Set();
let watcherStarted = false;
let botRef = null;
function getDeletionWatcherStatus() {
    return {
        active: watcherStarted,
        mtproto_ready: (0, mtprotoConfigStore_1.isMtprotoSessionReady)(),
    };
}
function startTgPostDeletionWatcher(bot) {
    botRef = bot;
    if (!(0, mtprotoConfigStore_1.isMtprotoSessionReady)()) {
        logger_1.logger.info('[tgDeletionWatcher] MTProto not configured, skipping');
        return;
    }
    if (watcherStarted) {
        return;
    }
    watcherStarted = true;
    setTimeout(() => {
        initWatcher().catch((err) => {
            logger_1.logger.warn('[tgDeletionWatcher] init failed', { err });
        });
    }, 30_000);
}
async function initWatcher() {
    const client = await (0, telegramUserArchive_1.getPersistentMtprotoClient)();
    if (!client) {
        logger_1.logger.warn('[tgDeletionWatcher] no MTProto client, will retry in 5 min');
        setTimeout(() => {
            initWatcher().catch(() => { });
        }, 5 * 60_000);
        return;
    }
    client.addEventHandler(async (update) => {
        try {
            await handleTelegramUpdate(update);
        }
        catch (err) {
            logger_1.logger.warn('[tgDeletionWatcher] update handler error', { err });
        }
    }, new events_1.Raw({ types: [telegram_1.Api.UpdateDeleteChannelMessages] }));
    logger_1.logger.info('[tgDeletionWatcher] listening for channel post deletions');
}
function normalizeMtprotoChannelId(channelId) {
    if (channelId === undefined || channelId === null) {
        return null;
    }
    const raw = typeof channelId === 'object' && channelId !== null && 'toString' in channelId
        ? channelId.toString()
        : String(channelId);
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return null;
    }
    return `-100${numeric}`;
}
function normalizeDeletedMessageIds(messages) {
    if (!messages?.length) {
        return [];
    }
    const out = [];
    for (const id of messages) {
        const numeric = Number(id);
        if (Number.isFinite(numeric) && numeric > 0) {
            out.push(numeric);
        }
    }
    return out;
}
async function handleTelegramUpdate(update) {
    if (!(update instanceof telegram_1.Api.UpdateDeleteChannelMessages)) {
        return;
    }
    const tgChannelId = normalizeMtprotoChannelId(update.channelId);
    const deletedMsgIds = normalizeDeletedMessageIds(update.messages);
    if (!tgChannelId || deletedMsgIds.length === 0) {
        return;
    }
    const channelIdBare = tgChannelId.replace(/^-100/, '');
    const chains = (0, adminPanelState_1.listTgChainsSync)().filter((c) => c.active &&
        c.forward_posts &&
        (c.tg_channel_id === tgChannelId || c.tg_channel_id === channelIdBare));
    if (chains.length === 0) {
        return;
    }
    logger_1.logger.info('[tgDeletionWatcher] channel post deleted in TG', {
        tgChannelId,
        deletedMsgIds,
        matchedChains: chains.length,
    });
    const db = (0, database_1.getDb)();
    for (const msgId of deletedMsgIds) {
        for (const chain of chains) {
            try {
                await handleDeletedPost(db, chain.id, tgChannelId, msgId);
            }
            catch (err) {
                logger_1.logger.warn('[tgDeletionWatcher] failed to handle deletion', {
                    tgChannelId,
                    msgId,
                    chainId: chain.id,
                    err,
                });
            }
        }
    }
}
async function handleDeletedPost(db, chainId, _tgChannelId, tgMsgId) {
    const dedupeKey = `${chainId}:${tgMsgId}`;
    if (recentlyDeletedPosts.has(dedupeKey)) {
        return;
    }
    recentlyDeletedPosts.add(dedupeKey);
    setTimeout(() => recentlyDeletedPosts.delete(dedupeKey), 30_000);
    const mapping = db
        .prepare(`SELECT m.max_mid, p.post_id, p.chat_id, p.message_mid AS max_msg_id
       FROM post_comment_mapping m
       JOIN posts p ON p.message_mid = m.max_mid
       WHERE m.chain_id = ?
         AND m.tg_msg_id = ?
       LIMIT 1`)
        .get(chainId, tgMsgId);
    if (!mapping) {
        const post = db
            .prepare(`SELECT post_id, chat_id, message_mid AS max_msg_id,
                json_extract(data, '$.tg_msg_id') AS stored_tg_msg_id
         FROM posts
         WHERE json_extract(data, '$.tg_msg_id') = ?
         LIMIT 1`)
            .get(tgMsgId);
        if (!post) {
            logger_1.logger.debug('[tgDeletionWatcher] no post found for deleted TG msg', {
                tgMsgId,
                chainId,
            });
            return;
        }
        await deleteMaxPost(post.post_id, post.chat_id, post.max_msg_id, tgMsgId, chainId);
        return;
    }
    await deleteMaxPost(mapping.post_id, mapping.chat_id, mapping.max_msg_id, tgMsgId, chainId);
}
async function deleteMaxPost(postId, chatId, maxMsgId, tgMsgId, chainId) {
    const db = (0, database_1.getDb)();
    const mid = maxMsgId?.trim() ?? '';
    if (mid !== '' && botRef) {
        try {
            await (0, maxApiRetry_1.apiCallWithRetry)(() => botRef.api.deleteMessage(mid));
            logger_1.logger.info('[tgDeletionWatcher] deleted MAX post', {
                postId,
                chatId,
                maxMsgId: mid,
                tgMsgId,
            });
        }
        catch (err) {
            const axiosCode = axios_1.default.isAxiosError(err) &&
                err.response?.data &&
                typeof err.response.data === 'object' &&
                'code' in err.response.data
                ? String(err.response.data.code ?? '')
                : '';
            const status = axios_1.default.isAxiosError(err) ? err.response?.status : undefined;
            if (axiosCode !== 'message.not_found' && status !== 404) {
                logger_1.logger.warn('[tgDeletionWatcher] MAX delete failed', {
                    postId,
                    maxMsgId: mid,
                    err: String(err),
                });
            }
        }
    }
    db.prepare(`DELETE FROM post_comment_mapping
     WHERE max_mid = (SELECT message_mid FROM posts WHERE post_id = ?)`).run(postId);
    db.prepare(`UPDATE comments
     SET tg_comment_id = -999
     WHERE post_id = ?
       AND (tg_comment_id IS NULL OR tg_comment_id = 0 OR tg_comment_id > 0)`).run(postId);
    db.prepare('DELETE FROM posts WHERE post_id = ?').run(postId);
    logger_1.logger.info('[tgDeletionWatcher] post cleanup complete', {
        postId,
        chatId,
        tgMsgId,
        chainId,
    });
}
//# sourceMappingURL=tgPostDeletionWatcher.js.map