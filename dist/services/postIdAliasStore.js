"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rememberPostIdAlias = rememberPostIdAlias;
exports.findPostByAlias = findPostByAlias;
const database_1 = require("../db/database");
const logger_1 = require("../utils/logger");
const postStore_1 = require("./postStore");
/**
 * Maps orphan `post_id` from an old button link → canonical row in `posts`.
 * Makes repeat Mini App opens instant after the first successful recovery.
 */
function rememberPostIdAlias(aliasPostId, post) {
    const alias = aliasPostId.trim().toLowerCase();
    const canonical = post.post_id.trim().toLowerCase();
    if (!alias || !canonical || alias === canonical) {
        return;
    }
    (0, database_1.getDb)()
        .prepare(`INSERT INTO post_id_aliases (alias_post_id, post_id, chat_id, message_mid)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(alias_post_id) DO UPDATE SET
         post_id = excluded.post_id,
         chat_id = excluded.chat_id,
         message_mid = excluded.message_mid`)
        .run(alias, post.post_id, post.chat_id, post.message_mid);
    logger_1.logger.info('postIdAlias: remembered orphan button post_id', {
        aliasPostId: alias,
        postId: post.post_id,
        chatId: post.chat_id,
        messageMid: post.message_mid,
    });
}
function findPostByAlias(aliasPostId) {
    const alias = aliasPostId.trim();
    if (!alias) {
        return null;
    }
    const row = (0, database_1.getDb)()
        .prepare('SELECT post_id FROM post_id_aliases WHERE alias_post_id = ?')
        .get(alias);
    if (!row) {
        const lower = alias.toLowerCase();
        if (lower !== alias) {
            const rowLower = (0, database_1.getDb)()
                .prepare('SELECT post_id FROM post_id_aliases WHERE alias_post_id = ?')
                .get(lower);
            if (rowLower) {
                return postStore_1.postStore.getPost(rowLower.post_id);
            }
        }
        return null;
    }
    return postStore_1.postStore.getPost(row.post_id);
}
//# sourceMappingURL=postIdAliasStore.js.map