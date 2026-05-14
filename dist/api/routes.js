"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCommentApiRouter = createCommentApiRouter;
const express_1 = __importDefault(require("express"));
const channelRegistry_1 = require("../services/channelRegistry");
const commentStore_1 = require("../services/commentStore");
const notificationService_1 = require("../services/notificationService");
const postStore_1 = require("../services/postStore");
const logger_1 = require("../utils/logger");
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parsePositiveInt(value) {
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
function parseNonEmptyString(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const t = value.trim();
    return t === '' ? null : t;
}
function toWireComment(c) {
    return {
        comment_id: c.comment_id,
        post_id: c.post_id,
        user_id: c.user_id,
        username: c.username,
        text: c.text,
        timestamp: c.timestamp,
        reply: c.reply,
    };
}
/**
 * Express router for Mini App REST API (`/api/...`).
 */
function createCommentApiRouter(deps) {
    const router = express_1.default.Router();
    router.use(express_1.default.json({ limit: '512kb' }));
    router.get('/post/:postId', (req, res) => {
        const post = postStore_1.postStore.getPost(req.params.postId);
        if (!post) {
            res.status(404).json({ error: 'post not found' });
            return;
        }
        const channel = channelRegistry_1.channelRegistry.getChannel(post.chat_id);
        res.json({
            post_id: post.post_id,
            text: post.text,
            photo_url: post.photo_url ?? null,
            chat_id: post.chat_id,
            comment_count: post.comment_count,
            channel_title: channel?.title ?? null,
        });
    });
    router.get('/comments/:postId', (req, res) => {
        const list = commentStore_1.commentStore.getComments(req.params.postId).map(toWireComment);
        res.json(list);
    });
    router.post('/comment', async (req, res) => {
        const body = req.body;
        if (!isRecord(body)) {
            res.status(400).json({ error: 'invalid body' });
            return;
        }
        const postId = parseNonEmptyString(body.post_id);
        const chatId = parsePositiveInt(body.chat_id);
        const userId = parsePositiveInt(body.user_id);
        const username = parseNonEmptyString(body.username);
        const text = parseNonEmptyString(body.text);
        if (!postId || !chatId || !userId || !username || !text) {
            res.status(400).json({ error: 'missing or invalid fields' });
            return;
        }
        const post = postStore_1.postStore.getPost(postId);
        if (!post || post.chat_id !== chatId) {
            res.status(404).json({ error: 'post not found' });
            return;
        }
        const saved = commentStore_1.commentStore.saveComment({
            post_id: postId,
            user_id: userId,
            username,
            text,
        });
        const newCount = postStore_1.postStore.incrementCommentCount(postId);
        if (newCount === null) {
            res.status(500).json({ error: 'post update failed' });
            return;
        }
        const updatedPost = postStore_1.postStore.getPost(postId);
        if (updatedPost) {
            await postStore_1.postStore.updateButtonCaption(deps.bot, updatedPost);
        }
        const channelTitle = channelRegistry_1.channelRegistry.getChannel(chatId)?.title ?? '—';
        try {
            await (0, notificationService_1.notifyAdminsNewMiniappComment)(deps.bot, {
                channelChatId: chatId,
                postText: post.text,
                channelTitle,
                username,
                commentText: text,
                postId,
            });
        }
        catch (err) {
            logger_1.logger.warn('POST /api/comment: notify admins failed', { err });
        }
        res.json({ comment_id: saved.comment_id, timestamp: saved.timestamp });
    });
    router.post('/reply', async (req, res) => {
        const body = req.body;
        if (!isRecord(body)) {
            res.status(400).json({ error: 'invalid body' });
            return;
        }
        const commentId = parseNonEmptyString(body.comment_id);
        const postId = parseNonEmptyString(body.post_id);
        const chatId = parsePositiveInt(body.chat_id);
        const adminText = parseNonEmptyString(body.admin_text);
        if (!commentId || !postId || !chatId || !adminText) {
            res.status(400).json({ error: 'missing or invalid fields' });
            return;
        }
        const post = postStore_1.postStore.getPost(postId);
        if (!post || post.chat_id !== chatId) {
            res.status(404).json({ error: 'post not found' });
            return;
        }
        const existing = commentStore_1.commentStore.getComment(commentId);
        if (!existing || existing.post_id !== postId) {
            res.status(404).json({ error: 'comment not found' });
            return;
        }
        const updated = commentStore_1.commentStore.addReply(commentId, adminText);
        if (!updated) {
            res.status(404).json({ error: 'comment not found' });
            return;
        }
        await (0, notificationService_1.notifyUserAboutMiniappReply)(deps.bot, {
            userId: updated.user_id,
            postText: post.text,
            userCommentText: updated.text,
            adminReplyText: adminText,
            postId,
            channelChatId: chatId,
        });
        res.json({ ok: true });
    });
    return router;
}
//# sourceMappingURL=routes.js.map