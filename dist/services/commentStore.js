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
    return typeof o.text === 'string' && typeof o.timestamp === 'string';
}
function isComment(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const o = value;
    return (typeof o.comment_id === 'string' &&
        typeof o.post_id === 'string' &&
        typeof o.user_id === 'number' &&
        Number.isInteger(o.user_id) &&
        typeof o.username === 'string' &&
        typeof o.text === 'string' &&
        typeof o.timestamp === 'string' &&
        (o.reply === undefined || isCommentReply(o.reply)));
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
                if (isComment(item)) {
                    this.comments.push(item);
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
     */
    addReply(commentId, replyText) {
        const c = this.comments.find((x) => x.comment_id === commentId);
        if (!c) {
            return null;
        }
        c.reply = { text: replyText, timestamp: new Date().toISOString() };
        this.queuePersist();
        logger_1.logger.info(`commentStore: reply on ${commentId}`);
        return c;
    }
    /**
     * Returns a single comment or `null`.
     */
    getComment(commentId) {
        return this.comments.find((c) => c.comment_id === commentId) ?? null;
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