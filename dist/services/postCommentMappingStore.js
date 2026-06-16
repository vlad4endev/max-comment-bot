"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertPostCommentMapping = upsertPostCommentMapping;
exports.linkThreadMessageToChannelPost = linkThreadMessageToChannelPost;
exports.findMappingByThreadMsgId = findMappingByThreadMsgId;
exports.findMappingByTgMsgId = findMappingByTgMsgId;
exports.findMappingByMaxMid = findMappingByMaxMid;
exports.backfillPostCommentMappingsFromForwarded = backfillPostCommentMappingsFromForwarded;
exports.resolveDiscussionChatId = resolveDiscussionChatId;
exports.storeDiscussionChatIdForChain = storeDiscussionChatIdForChain;
const axios_1 = __importDefault(require("axios"));
const database_1 = require("../db/database");
const logger_1 = require("../utils/logger");
const TG_API = 'https://api.telegram.org';
const discussionChatCache = new Map();
function upsertPostCommentMapping(chainId, tgMsgId, maxMid, tgChatId) {
    (0, database_1.getDb)()
        .prepare(`INSERT INTO post_comment_mapping (chain_id, tg_msg_id, max_mid, tg_chat_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chain_id, tg_msg_id) DO UPDATE SET
         max_mid    = excluded.max_mid,
         tg_chat_id = excluded.tg_chat_id`)
        .run(chainId, tgMsgId, maxMid, tgChatId);
}
function linkThreadMessageToChannelPost(chainId, channelMsgId, threadChatId, threadMsgId) {
    (0, database_1.getDb)()
        .prepare(`UPDATE post_comment_mapping
       SET tg_thread_chat_id = ?, tg_thread_msg_id = ?
       WHERE chain_id = ? AND tg_msg_id = ?`)
        .run(threadChatId, threadMsgId, chainId, channelMsgId);
}
function findMappingByThreadMsgId(chainId, threadMsgId) {
    const row = (0, database_1.getDb)()
        .prepare(`SELECT chain_id, tg_msg_id, max_mid, tg_chat_id, tg_thread_chat_id, tg_thread_msg_id
       FROM post_comment_mapping
       WHERE chain_id = ? AND tg_thread_msg_id = ?`)
        .get(chainId, threadMsgId);
    return row ?? null;
}
function findMappingByTgMsgId(chainId, tgMsgId) {
    const row = (0, database_1.getDb)()
        .prepare(`SELECT chain_id, tg_msg_id, max_mid, tg_chat_id, tg_thread_chat_id, tg_thread_msg_id
       FROM post_comment_mapping
       WHERE chain_id = ? AND tg_msg_id = ?
       ORDER BY id DESC
       LIMIT 1`)
        .get(chainId, tgMsgId);
    return row ?? null;
}
function findMappingByMaxMid(maxMid) {
    const normalized = maxMid.trim();
    if (!normalized) {
        return null;
    }
    const row = (0, database_1.getDb)()
        .prepare(`SELECT chain_id, tg_msg_id, max_mid, tg_chat_id, tg_thread_chat_id, tg_thread_msg_id
       FROM post_comment_mapping
       WHERE max_mid = ?
       ORDER BY id DESC
       LIMIT 1`)
        .get(normalized);
    return row ?? null;
}
/**
 * Заполняет post_comment_mapping из tg_chain_forwarded для постов,
 * пересланных до включения синхронизации комментариев.
 */
function backfillPostCommentMappingsFromForwarded() {
    const db = (0, database_1.getDb)();
    const rows = db
        .prepare(`SELECT chain_id, tg_message_id, max_message_mid, tg_payload
       FROM tg_chain_forwarded
       WHERE max_message_mid IS NOT NULL AND TRIM(max_message_mid) != ''`)
        .all();
    const insert = db.prepare(`INSERT INTO post_comment_mapping (chain_id, tg_msg_id, max_mid, tg_chat_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chain_id, tg_msg_id) DO NOTHING`);
    let inserted = 0;
    for (const row of rows) {
        let tgChatId = null;
        if (row.tg_payload) {
            try {
                const parsed = JSON.parse(row.tg_payload);
                if (typeof parsed.chat?.id === 'number') {
                    tgChatId = parsed.chat.id;
                }
            }
            catch {
                // ignore corrupt payload
            }
        }
        const result = insert.run(row.chain_id, row.tg_message_id, row.max_message_mid.trim(), tgChatId);
        inserted += Number(result.changes) || 0;
    }
    if (inserted > 0) {
        logger_1.logger.info('[postCommentMapping] backfilled mappings from tg_chain_forwarded', {
            inserted,
        });
    }
    return inserted;
}
async function resolveDiscussionChatId(tgToken, chain) {
    const manual = chain.tg_discussion_chat_id?.trim();
    if (manual && /^-?\d+$/.test(manual)) {
        return Number(manual);
    }
    const cacheKey = `${chain.id}:${tgToken}`;
    if (discussionChatCache.has(cacheKey)) {
        return discussionChatCache.get(cacheKey) ?? null;
    }
    const channelKey = chain.tg_channel_id?.trim() || chain.tg_username?.trim().replace(/^@/, '');
    if (!channelKey) {
        discussionChatCache.set(cacheKey, null);
        return null;
    }
    const chatId = /^-?\d+$/.test(channelKey)
        ? channelKey
        : `@${channelKey.replace(/^@/, '')}`;
    try {
        const { data } = await axios_1.default.get(`${TG_API}/bot${tgToken}/getChat`, {
            params: { chat_id: chatId },
            timeout: 15_000,
        });
        const linked = data.ok && typeof data.result?.linked_chat_id === 'number'
            ? data.result.linked_chat_id
            : null;
        discussionChatCache.set(cacheKey, linked);
        return linked;
    }
    catch (err) {
        logger_1.logger.warn('postCommentMapping: getChat linked_chat_id failed', { chainId: chain.id, err });
        discussionChatCache.set(cacheKey, null);
        return null;
    }
}
async function storeDiscussionChatIdForChain(tgToken, chain) {
    const threadChatId = await resolveDiscussionChatId(tgToken, chain);
    if (threadChatId == null) {
        return;
    }
    (0, database_1.getDb)()
        .prepare(`UPDATE post_comment_mapping
       SET tg_thread_chat_id = ?
       WHERE chain_id = ? AND (tg_thread_chat_id IS NULL OR tg_thread_chat_id = 0)`)
        .run(threadChatId, chain.id);
}
//# sourceMappingURL=postCommentMappingStore.js.map