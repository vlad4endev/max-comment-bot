"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.commentStore = exports.CommentStore = void 0;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const uuid_1 = require("uuid");
const logger_1 = require("../utils/logger");
const DEFAULT_COMMENTS_PATH = (0, node_path_1.join)(process.cwd(), 'data', 'comments.json');
function isCommentReply(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const o = value;
    if (o.admin_name !== undefined && typeof o.admin_name !== 'string') {
        return false;
    }
    return typeof o.text === 'string' && typeof o.timestamp === 'string';
}
function parseStoredUserId(value) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
        return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number.parseInt(value, 10);
        if (Number.isInteger(n) && n > 0) {
            return n;
        }
    }
    return null;
}
function isCommentAdminNotificationMid(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const o = value;
    return (typeof o.admin_id === 'number' &&
        Number.isInteger(o.admin_id) &&
        typeof o.message_mid === 'string');
}
function normalizeCommentFromDisk(raw) {
    if (typeof raw !== 'object' || raw === null) {
        return null;
    }
    const o = raw;
    const userId = parseStoredUserId(o.user_id);
    if (userId === null ||
        typeof o.comment_id !== 'string' ||
        typeof o.post_id !== 'string' ||
        typeof o.username !== 'string' ||
        typeof o.text !== 'string' ||
        typeof o.timestamp !== 'string' ||
        (o.reply !== undefined && !isCommentReply(o.reply))) {
        return null;
    }
    if (o.notification_text !== undefined && typeof o.notification_text !== 'string') {
        return null;
    }
    if (o.notification_mids !== undefined) {
        if (!Array.isArray(o.notification_mids)) {
            return null;
        }
        for (const row of o.notification_mids) {
            if (!isCommentAdminNotificationMid(row)) {
                return null;
            }
        }
    }
    return {
        comment_id: o.comment_id,
        post_id: o.post_id,
        user_id: userId,
        username: o.username,
        text: o.text,
        timestamp: o.timestamp,
        ...(o.reply !== undefined ? { reply: o.reply } : {}),
        ...(o.notification_text !== undefined
            ? { notification_text: o.notification_text }
            : {}),
        ...(o.notification_mids !== undefined
            ? { notification_mids: o.notification_mids }
            : {}),
    };
}
/**
 * JSON-backed comment list with async persistence under `data/comments.json`.
 */
class CommentStore {
    comments = [];
    filePath;
    persistChain = Promise.resolve();
    constructor(filePath = DEFAULT_COMMENTS_PATH) {
        this.filePath = filePath;
    }
    /**
     * Loads comments from disk (replaces in-memory list).
     */
    async loadFromDisk() {
        try {
            const raw = await (0, promises_1.readFile)(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (typeof parsed !== 'object' || parsed === null || !('comments' in parsed)) {
                logger_1.logger.warn('commentStore: invalid comments.json shape, starting empty');
                this.comments.length = 0;
                return;
            }
            const list = parsed.comments;
            if (!Array.isArray(list)) {
                this.comments.length = 0;
                return;
            }
            this.comments.length = 0;
            for (const item of list) {
                const normalized = normalizeCommentFromDisk(item);
                if (normalized) {
                    this.comments.push(normalized);
                }
            }
            logger_1.logger.info(`commentStore: loaded ${this.comments.length} comment(s)`);
        }
        catch (e) {
            const err = e;
            if (err.code === 'ENOENT') {
                logger_1.logger.debug('commentStore: comments.json missing, empty store');
                return;
            }
            logger_1.logger.error('commentStore: failed to read comments.json', e);
        }
    }
    /**
     * Appends a new comment (assigns id and ISO timestamp) and persists.
     */
    saveComment(input) {
        const comment = {
            ...input,
            comment_id: (0, uuid_1.v4)(),
            timestamp: new Date().toISOString(),
        };
        this.comments.push(comment);
        this.queuePersist();
        logger_1.logger.info(`commentStore: saved ${comment.comment_id}`);
        return comment;
    }
    /**
     * Returns comments for a post, oldest first.
     */
    getComments(postId) {
        return this.comments
            .filter((c) => c.post_id === postId)
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    }
    /**
     * Attaches a channel reply to a comment. Returns updated comment or `null`.
     * @param replyAdminName optional display name of the replying admin (non-empty trimmed string is stored).
     */
    addReply(commentId, replyText, replyAdminName) {
        const c = this.comments.find((x) => x.comment_id === commentId);
        if (!c) {
            return null;
        }
        const trimmedName = replyAdminName?.trim();
        const reply = { text: replyText, timestamp: new Date().toISOString() };
        if (trimmedName) {
            reply.admin_name = trimmedName;
        }
        c.reply = reply;
        this.queuePersist();
        logger_1.logger.info(`commentStore: reply on ${commentId}`);
        return c;
    }
    /**
     * Updates comment body text. Returns updated comment or `null`.
     */
    updateCommentText(commentId, text) {
        const c = this.comments.find((x) => x.comment_id === commentId);
        if (!c) {
            return null;
        }
        c.text = text;
        this.queuePersist();
        logger_1.logger.info(`commentStore: updated text ${commentId}`);
        return c;
    }
    /**
     * Updates an existing admin reply (preserves original timestamp). Returns `null` if missing.
     */
    updateReply(commentId, replyText, replyAdminName) {
        const c = this.comments.find((x) => x.comment_id === commentId);
        if (!c?.reply) {
            return null;
        }
        c.reply.text = replyText;
        const trimmedName = replyAdminName?.trim();
        if (trimmedName) {
            c.reply.admin_name = trimmedName;
        }
        else {
            delete c.reply.admin_name;
        }
        this.queuePersist();
        logger_1.logger.info(`commentStore: updated reply ${commentId}`);
        return c;
    }
    /**
     * Removes the admin reply from a comment. Returns updated comment or `null`.
     */
    deleteReply(commentId) {
        const c = this.comments.find((x) => x.comment_id === commentId);
        if (!c?.reply) {
            return null;
        }
        delete c.reply;
        this.queuePersist();
        logger_1.logger.info(`commentStore: deleted reply ${commentId}`);
        return c;
    }
    /**
     * Deletes a comment entirely. Returns removed comment or `null`.
     */
    deleteComment(commentId) {
        const idx = this.comments.findIndex((x) => x.comment_id === commentId);
        if (idx < 0) {
            return null;
        }
        const [removed] = this.comments.splice(idx, 1);
        this.queuePersist();
        logger_1.logger.info(`commentStore: deleted ${commentId}`);
        return removed;
    }
    /**
     * Returns a single comment or `null`.
     */
    getComment(commentId) {
        return this.comments.find((c) => c.comment_id === commentId) ?? null;
    }
    /**
     * Persists the admin DM template text for this comment (used when editing notifications after reply).
     */
    saveNotificationText(commentId, text) {
        const c = this.comments.find((x) => x.comment_id === commentId);
        if (!c) {
            return;
        }
        c.notification_text = text;
        this.queuePersist();
    }
    /**
     * Records the DM `message_mid` for one admin (upserts by `admin_id`).
     */
    saveNotificationMid(commentId, adminId, mid) {
        const c = this.comments.find((x) => x.comment_id === commentId);
        if (!c) {
            return;
        }
        const list = c.notification_mids ?? [];
        const idx = list.findIndex((e) => e.admin_id === adminId);
        const entry = { admin_id: adminId, message_mid: mid };
        if (idx >= 0) {
            list[idx] = entry;
        }
        else {
            list.push(entry);
        }
        c.notification_mids = list;
        this.queuePersist();
    }
    getNotificationMids(commentId) {
        const c = this.comments.find((x) => x.comment_id === commentId);
        return c?.notification_mids ? [...c.notification_mids] : [];
    }
    /**
     * Counts comments whose posts belong to the given channel (`postIds` from postStore).
     */
    countForPostIds(postIds) {
        if (postIds.size === 0) {
            return 0;
        }
        return this.comments.filter((c) => postIds.has(c.post_id)).length;
    }
    queuePersist() {
        this.persistChain = this.persistChain
            .then(() => this.persist())
            .catch((e) => {
            logger_1.logger.error('commentStore: persist error', e);
        });
    }
    async persist() {
        const dir = (0, node_path_1.dirname)(this.filePath);
        await (0, promises_1.mkdir)(dir, { recursive: true });
        const body = { comments: [...this.comments] };
        await (0, promises_1.writeFile)(this.filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    }
}
exports.CommentStore = CommentStore;
exports.commentStore = new CommentStore();
//# sourceMappingURL=commentStore.js.map