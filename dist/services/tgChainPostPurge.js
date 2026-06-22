"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.purgeTgChainForwardedMaxPosts = purgeTgChainForwardedMaxPosts;
const adminPanelState_1 = require("../api/adminPanelState");
const database_1 = require("../db/database");
const commentStore_1 = require("./commentStore");
const postStore_1 = require("./postStore");
const logger_1 = require("../utils/logger");
const maxApiRetry_1 = require("../utils/maxApiRetry");
const DELETE_INTERVAL_MS = 600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function findTgChain(chainId) {
    return (0, adminPanelState_1.listTgChainsSync)().find((c) => c.id === chainId) ?? null;
}
async function deleteMaxMessage(bot, messageMid) {
    try {
        await (0, maxApiRetry_1.apiCallWithRetry)(() => bot.api.deleteMessage(messageMid));
        return true;
    }
    catch (err) {
        logger_1.logger.warn('[tgChainPurge] deleteMessage failed', { messageMid, err });
        return false;
    }
}
function listForwardedMaxMids(chainId, sinceIso, untilIso, limit) {
    const params = [chainId, sinceIso];
    let sql = `
    SELECT DISTINCT TRIM(max_message_mid) AS mid
    FROM tg_chain_forwarded
    WHERE chain_id = ?
      AND max_message_mid IS NOT NULL
      AND TRIM(max_message_mid) != ''
      AND forwarded_at >= ?
  `;
    if (untilIso) {
        sql += ' AND forwarded_at < ?';
        params.push(untilIso);
    }
    sql += ' ORDER BY forwarded_at ASC LIMIT ?';
    params.push(limit);
    const rows = (0, database_1.getDb)().prepare(sql).all(...params);
    return rows.map((r) => r.mid.trim()).filter((m) => m !== '');
}
/**
 * Удаляет из MAX посты, созданные пересылкой TG→MAX для связки (по tg_chain_forwarded).
 */
async function purgeTgChainForwardedMaxPosts(bot, chainId, options) {
    const chain = findTgChain(chainId);
    if (!chain) {
        throw new Error('chain_not_found');
    }
    const since = options?.sinceIso?.trim() ||
        chain.forward_posts_since?.trim() ||
        chain.created_at?.trim() ||
        new Date(0).toISOString();
    const until = options?.untilIso?.trim() || null;
    const limit = Math.max(1, Math.min(2000, Math.floor(options?.limit ?? 500)));
    const dryRun = options?.dryRun === true;
    const mids = listForwardedMaxMids(chain.id, since, until, limit);
    const result = {
        chain_id: chain.id,
        max_chat_id: chain.max_chat_id,
        since,
        until,
        scanned_mids: mids.length,
        deleted: 0,
        failed: 0,
        dry_run: dryRun,
        sample_mids: mids.slice(0, 10),
    };
    if (dryRun || mids.length === 0) {
        return result;
    }
    const deleteMapping = (0, database_1.getDb)().prepare(`DELETE FROM post_comment_mapping WHERE chain_id = ? AND max_mid = ?`);
    for (const mid of mids) {
        const post = postStore_1.postStore.findPostByChannelMessage(chain.max_chat_id, mid) ??
            postStore_1.postStore.findByMessageMid(mid);
        const midsToDelete = new Set([mid]);
        if (post?.comments_ui_message_mid?.trim()) {
            midsToDelete.add(post.comments_ui_message_mid.trim());
        }
        if (post) {
            commentStore_1.commentStore.removeCommentsByPostIds(new Set([post.post_id]));
            postStore_1.postStore.deletePostById(post.post_id);
        }
        deleteMapping.run(chain.id, mid);
        let ok = true;
        for (const m of midsToDelete) {
            const deleted = await deleteMaxMessage(bot, m);
            if (!deleted) {
                ok = false;
            }
            await sleep(DELETE_INTERVAL_MS);
        }
        if (ok) {
            result.deleted += 1;
        }
        else {
            result.failed += 1;
        }
    }
    logger_1.logger.info('[tgChainPurge] purge completed', result);
    return result;
}
//# sourceMappingURL=tgChainPostPurge.js.map