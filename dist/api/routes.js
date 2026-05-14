"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCommentApiRouter = createCommentApiRouter;
const express_1 = __importDefault(require("express"));
const config_1 = require("../config");
const channelRegistry_1 = require("../services/channelRegistry");
const channelPostActions_1 = require("../services/channelPostActions");
const commentStore_1 = require("../services/commentStore");
const notificationService_1 = require("../services/notificationService");
const postStore_1 = require("../services/postStore");
const stateManager_1 = require("../services/stateManager");
const userMiniappSettingsStore_1 = require("../services/userMiniappSettingsStore");
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
function parseBoolean(value) {
    if (typeof value === 'boolean') {
        return value;
    }
    if (value === 'true' || value === '1') {
        return true;
    }
    if (value === 'false' || value === '0') {
        return false;
    }
    return null;
}
async function listChannelChatIdsWhereUserIsAdmin(bot, userId) {
    const registered = channelRegistry_1.channelRegistry
        .getAllChannels()
        .filter((c) => c.type === 'channel')
        .map((c) => c.chat_id);
    const flags = await Promise.all(registered.map(async (chatId) => (await (0, channelPostActions_1.isUserChannelAdmin)(bot, chatId, userId)) ? chatId : null));
    return flags.filter((x) => x !== null).sort((a, b) => a - b);
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
    router.get('/stats', async (req, res) => {
        const userId = parsePositiveInt(req.query.user_id);
        if (!userId) {
            res.status(400).json({ error: 'missing or invalid user_id' });
            return;
        }
        try {
            const adminChannelIds = await listChannelChatIdsWhereUserIsAdmin(deps.bot, userId);
            let posts = 0;
            const postIds = new Set();
            for (const chatId of adminChannelIds) {
                const list = postStore_1.postStore.getPostsByChatId(chatId);
                posts += list.length;
                for (const p of list) {
                    postIds.add(p.post_id);
                }
            }
            const comments = commentStore_1.commentStore.countForPostIds(postIds);
            res.json({
                channels: adminChannelIds.length,
                posts,
                comments,
                bot_nickname: config_1.config.BOT_NICKNAME,
            });
        }
        catch (err) {
            logger_1.logger.error('GET /api/stats failed', { err });
            res.status(500).json({ error: 'internal error' });
        }
    });
    router.get('/channels', async (req, res) => {
        const userId = parsePositiveInt(req.query.user_id);
        if (!userId) {
            res.status(400).json({ error: 'missing or invalid user_id' });
            return;
        }
        try {
            const adminChannelIds = await listChannelChatIdsWhereUserIsAdmin(deps.bot, userId);
            const channels = await Promise.all(adminChannelIds.map(async (chatId) => {
                const reg = channelRegistry_1.channelRegistry.getChannel(chatId);
                let subscribers = null;
                try {
                    const chat = await deps.bot.api.getChat(chatId);
                    const raw = chat.participants_count;
                    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
                        subscribers = raw;
                    }
                }
                catch {
                    subscribers = null;
                }
                const pending = stateManager_1.stateManager.isChannelPendingAdminRights(chatId);
                return {
                    chat_id: chatId,
                    title: reg?.title ?? null,
                    subscribers,
                    status: pending ? 'pending' : 'active',
                };
            }));
            res.json({ channels, bot_nickname: config_1.config.BOT_NICKNAME });
        }
        catch (err) {
            logger_1.logger.error('GET /api/channels failed', { err });
            res.status(500).json({ error: 'internal error' });
        }
    });
    router.get('/settings', (req, res) => {
        const userId = parsePositiveInt(req.query.user_id);
        if (!userId) {
            res.status(400).json({ error: 'missing or invalid user_id' });
            return;
        }
        res.json(userMiniappSettingsStore_1.userMiniappSettingsStore.getMerged(userId));
    });
    router.post('/settings', (req, res) => {
        const body = req.body;
        if (!isRecord(body)) {
            res.status(400).json({ error: 'invalid body' });
            return;
        }
        const userId = parsePositiveInt(body.user_id);
        const feature = (0, userMiniappSettingsStore_1.parseMiniappFeatureKey)(body.feature);
        const enabled = parseBoolean(body.enabled);
        if (!userId || !feature || enabled === null) {
            res.status(400).json({ error: 'missing or invalid fields' });
            return;
        }
        const next = userMiniappSettingsStore_1.userMiniappSettingsStore.setFeature(userId, feature, enabled);
        res.json(next);
    });
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