"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.allocatePostId = allocatePostId;
exports.parsePostIdFromStartappSegment = parsePostIdFromStartappSegment;
exports.formatPostIdForStartapp = formatPostIdForStartapp;
exports.isNumericPostId = isNumericPostId;
const database_1 = require("../db/database");
const startappPayload_1 = require("./startappPayload");
/** Telegram-style monotonic post id (decimal string, unique in `posts`). */
function allocatePostId() {
    const db = (0, database_1.getDb)();
    const run = db.transaction(() => {
        const row = db.prepare('SELECT next_id FROM post_id_sequence WHERE id = 1').get();
        const next = row?.next_id ?? 1;
        db.prepare('UPDATE post_id_sequence SET next_id = ? WHERE id = 1').run(next + 1);
        return String(next);
    });
    return run();
}
/** Segment after `pid_` in MAX startapp: decimal id or 32-char UUID hex. */
function parsePostIdFromStartappSegment(segment) {
    const raw = segment.trim();
    if (!raw) {
        return null;
    }
    if (/^\d+$/.test(raw)) {
        return raw;
    }
    return (0, startappPayload_1.compactUuidToStandard)(raw);
}
/** Encodes `post_id` for `pid_<…>_cid_…` (numeric as-is, UUID without dashes). */
function formatPostIdForStartapp(postId) {
    const id = postId.trim();
    if (/^\d+$/.test(id)) {
        return id;
    }
    return id.replace(/-/g, '');
}
function isNumericPostId(postId) {
    return /^\d+$/.test(postId.trim());
}
//# sourceMappingURL=postId.js.map