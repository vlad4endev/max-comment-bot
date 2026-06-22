"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveTelegramChannelKeyForMapping = resolveTelegramChannelKeyForMapping;
exports.listTelegramChannelKeyCandidatesForMapping = listTelegramChannelKeyCandidatesForMapping;
exports.countMappingChannelIdMismatch = countMappingChannelIdMismatch;
exports.upsertPostCommentMapping = upsertPostCommentMapping;
exports.linkThreadMessageToChannelPost = linkThreadMessageToChannelPost;
exports.clearPostThreadMapping = clearPostThreadMapping;
exports.deletePostCommentMapping = deletePostCommentMapping;
exports.backfillPostCommentMappingForMaxMid = backfillPostCommentMappingForMaxMid;
exports.countPostMappingThreadStats = countPostMappingThreadStats;
exports.listMappingsMissingThread = listMappingsMissingThread;
exports.findMappingByThreadMsgId = findMappingByThreadMsgId;
exports.findMappingByTgMsgId = findMappingByTgMsgId;
exports.findMappingByMaxMid = findMappingByMaxMid;
exports.backfillPostCommentMappingsFromForwarded = backfillPostCommentMappingsFromForwarded;
exports.resolveDiscussionChatId = resolveDiscussionChatId;
exports.storeDiscussionChatIdForChain = storeDiscussionChatIdForChain;
const axios_1 = __importDefault(require("axios"));
const adminPanelState_1 = require("../api/adminPanelState");
const database_1 = require("../db/database");
const logger_1 = require("../utils/logger");
const tgChannelMatch_1 = require("../utils/tgChannelMatch");
const TG_API = 'https://api.telegram.org';
const discussionChatCache = new Map();
/** Ключ TG-канала для API: предпочитаем tg_chat_id из маппинга (фактический источник поста). */
function resolveTelegramChannelKeyForMapping(mapping, chain) {
    if (typeof mapping.tg_chat_id === 'number') {
        return String(mapping.tg_chat_id);
    }
    const resolvedChain = chain ?? (0, adminPanelState_1.listTgChainsSync)().find((c) => c.id === mapping.chain_id);
    const fromChainId = resolvedChain?.tg_channel_id?.trim();
    if (fromChainId) {
        return fromChainId;
    }
    const username = resolvedChain?.tg_username?.trim();
    if (username) {
        return username.startsWith('@') ? username : `@${username}`;
    }
    return null;
}
/** Уникальные ключи канала для GetDiscussionMessage (сначала tg_chat_id из маппинга). */
function listTelegramChannelKeyCandidatesForMapping(mapping, chain) {
    const resolvedChain = chain ?? (0, adminPanelState_1.listTgChainsSync)().find((c) => c.id === mapping.chain_id);
    const keys = [];
    const seen = new Set();
    const push = (key) => {
        const trimmed = key?.trim();
        if (!trimmed || seen.has(trimmed)) {
            return;
        }
        seen.add(trimmed);
        keys.push(trimmed);
    };
    if (typeof mapping.tg_chat_id === 'number') {
        push(String(mapping.tg_chat_id));
    }
    push(resolvedChain?.tg_channel_id);
    const username = resolvedChain?.tg_username?.trim();
    if (username) {
        push(username.startsWith('@') ? username : `@${username}`);
    }
    return keys;
}
function countMappingChannelIdMismatch(chainId) {
    const chain = (0, adminPanelState_1.listTgChainsSync)().find((c) => c.id === chainId);
    if (!chain) {
        return 0;
    }
    const chainKeys = [
        chain.tg_channel_id?.trim(),
        chain.tg_username?.trim() ? `@${chain.tg_username.trim().replace(/^@/, '')}` : null,
    ].filter(Boolean);
    if (chainKeys.length === 0) {
        return 0;
    }
    const rows = (0, database_1.getDb)()
        .prepare(`SELECT tg_chat_id
       FROM post_comment_mapping
       WHERE chain_id = ?
         AND tg_chat_id IS NOT NULL`)
        .all(chainId);
    let mismatched = 0;
    for (const row of rows) {
        const chat = { id: row.tg_chat_id };
        if (!chainKeys.some((key) => (0, tgChannelMatch_1.telegramChannelMatchesTarget)(chat, key))) {
            mismatched += 1;
        }
    }
    return mismatched;
}
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
/** Сбрасывает устаревший thread id — для повторного resolve через GetDiscussionMessage. */
function clearPostThreadMapping(chainId, tgMsgId) {
    (0, database_1.getDb)()
        .prepare(`UPDATE post_comment_mapping
       SET tg_thread_chat_id = NULL, tg_thread_msg_id = NULL
       WHERE chain_id = ? AND tg_msg_id = ?`)
        .run(chainId, tgMsgId);
}
/** Удаляет битый маппинг (MSG_ID_INVALID / удалённый пост в TG). */
function deletePostCommentMapping(chainId, tgMsgId) {
    const result = (0, database_1.getDb)()
        .prepare(`DELETE FROM post_comment_mapping WHERE chain_id = ? AND tg_msg_id = ?`)
        .run(chainId, tgMsgId);
    return Number(result.changes) > 0;
}
/** Пересоздаёт маппинг для max_mid из tg_chain_forwarded (последняя пересылка). */
function backfillPostCommentMappingForMaxMid(maxMid) {
    const normalized = maxMid.trim();
    if (!normalized) {
        return false;
    }
    const row = (0, database_1.getDb)()
        .prepare(`SELECT chain_id, tg_message_id, tg_payload
       FROM tg_chain_forwarded
       WHERE max_message_mid = ?
       ORDER BY forwarded_at DESC
       LIMIT 1`)
        .get(normalized);
    if (!row) {
        return false;
    }
    let tgChatId = null;
    if (row.tg_payload) {
        try {
            const parsed = JSON.parse(row.tg_payload);
            if (typeof parsed.chat?.id === 'number') {
                tgChatId = parsed.chat.id;
            }
        }
        catch {
            // ignore
        }
    }
    upsertPostCommentMapping(row.chain_id, row.tg_message_id, normalized, tgChatId);
    return true;
}
function countPostMappingThreadStats(chainId) {
    const where = chainId ? 'WHERE chain_id = ?' : '';
    const params = chainId ? [chainId] : [];
    const row = (0, database_1.getDb)()
        .prepare(`SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN tg_thread_msg_id IS NOT NULL AND tg_thread_msg_id > 0 THEN 1 ELSE 0 END) AS with_thread,
         SUM(CASE WHEN tg_thread_msg_id IS NULL OR tg_thread_msg_id <= 0 THEN 1 ELSE 0 END) AS missing_thread
       FROM post_comment_mapping
       ${where}`)
        .get(...params);
    return {
        total: Number(row.total) || 0,
        with_thread: Number(row.with_thread) || 0,
        missing_thread: Number(row.missing_thread) || 0,
    };
}
function listMappingsMissingThread(chainId, limit = 50) {
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    return (0, database_1.getDb)()
        .prepare(`SELECT chain_id, tg_msg_id, max_mid, tg_chat_id, tg_thread_chat_id, tg_thread_msg_id
       FROM post_comment_mapping
       WHERE chain_id = ?
         AND (tg_thread_msg_id IS NULL OR tg_thread_msg_id <= 0)
         AND tg_msg_id IS NOT NULL AND tg_msg_id > 0
       ORDER BY id DESC
       LIMIT ?`)
        .all(chainId, safeLimit);
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
    // Один max_mid может иметь несколько tg_msg_id (редактирование/альбом).
    // Предпочитаем строку с заполненным thread id — иначе sync ломается на «битой» последней записи.
    const row = (0, database_1.getDb)()
        .prepare(`SELECT chain_id, tg_msg_id, max_mid, tg_chat_id, tg_thread_chat_id, tg_thread_msg_id
       FROM post_comment_mapping
       WHERE max_mid = ?
       ORDER BY
         (CASE WHEN tg_thread_msg_id IS NOT NULL AND tg_thread_msg_id > 0 THEN 1 ELSE 0 END) DESC,
         id DESC
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
/**
 * Раньше проставлял tg_thread_chat_id без tg_thread_msg_id — из-за этого
 * findMappingByMaxMid выбирал «битую» строку. Thread id задаётся через
 * handleDiscussionAutoForward / ensurePostThreadMapping.
 */
async function storeDiscussionChatIdForChain(_tgToken, _chain) {
    // no-op
}
//# sourceMappingURL=postCommentMappingStore.js.map