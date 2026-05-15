"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCommentApiRouter = createCommentApiRouter;
const max_bot_api_1 = require("@maxhub/max-bot-api");
const express_1 = __importDefault(require("express"));
const config_1 = require("../config");
const channelNotifyLinkStore_1 = require("../services/channelNotifyLinkStore");
const channelRegistry_1 = require("../services/channelRegistry");
const resolveChannelChatId_1 = require("../services/resolveChannelChatId");
const channelPostActions_1 = require("../services/channelPostActions");
const commentStore_1 = require("../services/commentStore");
const subscriberStore_1 = require("../services/subscriberStore");
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
/** Channel / group chat ids are negative (e.g. -100…); reject 0 only. */
function parseNonZeroInt(value) {
    if (typeof value === 'number' && Number.isInteger(value) && value !== 0) {
        return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number.parseInt(value, 10);
        if (Number.isInteger(n) && n !== 0) {
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
function isChannelAdminOrOwnerMember(m) {
    return !m.is_bot && (m.is_admin || m.is_owner);
}
function adminDisplayInitials(name) {
    const t = name.trim();
    if (t === '') {
        return '?';
    }
    const parts = t.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
        const a = parts[0].charAt(0);
        const b = parts[parts.length - 1].charAt(0);
        return `${a}${b}`.toUpperCase();
    }
    return t.slice(0, 2).toUpperCase();
}
/**
 * Lists channel admins/owners: paginates {@link Bot.api.getChatMembers}, filters roles; if none found, uses {@link Bot.api.getChatAdmins}.
 */
async function listChannelAdminsForMiniApp(bot, chatId) {
    try {
        const { members } = await bot.api.getChatAdmins(chatId);
        const admins = members.filter(isChannelAdminOrOwnerMember);
        if (admins.length > 0) {
            return [...new Map(admins.map((m) => [m.user_id, m])).values()].sort((a, b) => a.user_id - b.user_id);
        }
    }
    catch (err) {
        logger_1.logger.warn('listChannelAdminsForMiniApp: getChatAdmins failed, falling back to members list', {
            chatId,
            err,
        });
    }
    const byId = new Map();
    let marker;
    const pageSize = 100;
    for (let page = 0; page < 100; page += 1) {
        const res = await bot.api.getChatMembers(chatId, {
            count: pageSize,
            ...(marker !== undefined ? { marker } : {}),
        });
        for (const m of res.members) {
            if (isChannelAdminOrOwnerMember(m)) {
                byId.set(m.user_id, m);
            }
        }
        const next = res.marker;
        if (next === undefined || next === null) {
            break;
        }
        marker = next;
    }
    if (byId.size > 0) {
        return [...byId.values()].sort((a, b) => a.user_id - b.user_id);
    }
    const { members } = await bot.api.getChatAdmins(chatId);
    return members.filter(isChannelAdminOrOwnerMember).sort((a, b) => a.user_id - b.user_id);
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
async function resolveAdminCommentAccess(bot, input) {
    const post = postStore_1.postStore.getPost(input.postId);
    if (!post || post.chat_id !== input.chatId) {
        return { ok: false, status: 404, error: 'post not found' };
    }
    if (!(await (0, channelPostActions_1.isUserChannelAdmin)(bot, post.chat_id, input.userId))) {
        return { ok: false, status: 403, error: 'Только администраторы могут изменять комментарии' };
    }
    const comment = commentStore_1.commentStore.getComment(input.commentId);
    if (!comment || comment.post_id !== input.postId) {
        return { ok: false, status: 404, error: 'comment not found' };
    }
    return { ok: true, comment, post };
}
/**
 * Express router for Mini App REST API (`/api/...`).
 */
function createCommentApiRouter(deps) {
    const router = express_1.default.Router();
    router.use(express_1.default.json({ limit: '512kb' }));
    router.get('/config', (_req, res) => {
        res.json({ bot_nickname: config_1.config.botNickname });
    });
    router.get('/channel-info', async (req, res) => {
        const chatId = parseNonZeroInt(req.query.chat_id);
        if (chatId === null) {
            res.status(400).json({ error: 'missing or invalid chat_id' });
            return;
        }
        const cached = channelRegistry_1.channelRegistry.getChannel(chatId);
        if (cached?.title) {
            res.json({ title: cached.title });
            return;
        }
        try {
            const chat = await deps.bot.api.getChat(chatId);
            res.json({ title: chat.title ?? null });
        }
        catch (err) {
            logger_1.logger.warn('GET /channel-info: getChat failed', { chatId, err });
            res.json({ title: cached?.title ?? null });
        }
    });
    router.get('/user-status', async (req, res) => {
        const userId = parsePositiveInt(req.query.user_id);
        if (!userId) {
            res.status(400).json({ error: 'missing or invalid user_id' });
            return;
        }
        const chatId = parseNonZeroInt(req.query.chat_id);
        const isSubscriber = subscriberStore_1.subscriberStore.hasSubscriber(userId);
        const isAdmin = chatId !== null ? await (0, channelPostActions_1.isUserChannelAdmin)(deps.bot, chatId, userId) : false;
        const showSubscribeBanner = !isSubscriber && !isAdmin;
        res.json({
            started: isSubscriber,
            is_admin: isAdmin,
            show_subscribe_banner: showSubscribeBanner,
            bot_nickname: config_1.config.BOT_NICKNAME,
        });
    });
    router.post('/register-subscriber', (req, res) => {
        const body = req.body;
        if (!isRecord(body)) {
            res.status(400).json({ error: 'invalid body' });
            return;
        }
        const userId = parsePositiveInt(body.user_id);
        if (!userId) {
            res.status(400).json({ error: 'missing or invalid user_id' });
            return;
        }
        const chatId = parseNonZeroInt(body.chat_id);
        const source = parseNonEmptyString(body.source);
        const wasAlreadySubscribed = subscriberStore_1.subscriberStore.hasSubscriber(userId);
        logger_1.logger.info('register-subscriber called', {
            userId: body.user_id,
            chatId: body.chat_id,
            source: body.source,
            wasAlreadySubscribed,
        });
        subscriberStore_1.subscriberStore.addSubscriber(userId);
        logger_1.logger.info('subscriber registered', { userId, chatId, source });
        res.json({ ok: true });
    });
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
    router.get('/channel-admins', async (req, res) => {
        const userId = parsePositiveInt(req.query.user_id);
        const chatIdRaw = parseNonZeroInt(req.query.chat_id);
        if (!userId || !chatIdRaw) {
            res.status(400).json({ error: 'missing or invalid user_id or chat_id' });
            return;
        }
        const chatId = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(chatIdRaw);
        if (chatId === null || !channelRegistry_1.channelRegistry.getChannel(chatId)) {
            res.status(404).json({ error: 'channel not connected' });
            return;
        }
        try {
            if (!(await (0, channelPostActions_1.isUserChannelAdmin)(deps.bot, chatId, userId))) {
                res.status(403).json({ error: 'Доступ запрещён' });
                return;
            }
            const members = await listChannelAdminsForMiniApp(deps.bot, chatId);
            const linkedIds = new Set(channelNotifyLinkStore_1.channelNotifyLinkStore.getUserIdsForChannel(chatId));
            const admins = members.map((m) => ({
                user_id: m.user_id,
                name: m.name,
                initials: adminDisplayInitials(m.name),
                linked: linkedIds.has(m.user_id),
            }));
            const listedIds = new Set(admins.map((a) => a.user_id));
            for (const linkedUserId of linkedIds) {
                if (listedIds.has(linkedUserId)) {
                    continue;
                }
                try {
                    const { members: linkedMembers } = await deps.bot.api.getChatMembers(chatId, {
                        user_ids: [linkedUserId],
                    });
                    const m = linkedMembers[0];
                    if (m && isChannelAdminOrOwnerMember(m)) {
                        admins.push({
                            user_id: m.user_id,
                            name: m.name,
                            initials: adminDisplayInitials(m.name),
                            linked: true,
                        });
                        listedIds.add(m.user_id);
                    }
                }
                catch (err) {
                    logger_1.logger.warn('GET /api/channel-admins: could not resolve linked admin', {
                        chatId,
                        linkedUserId,
                        err,
                    });
                }
            }
            admins.sort((a, b) => a.user_id - b.user_id);
            logger_1.logger.info('GET /api/channel-admins', {
                chatId,
                chatIdRaw,
                requestUserId: userId,
                linkedUserIds: [...linkedIds],
                adminUserIds: admins.map((a) => a.user_id),
            });
            const invite_url = `https://max.ru/${config_1.config.botNickname}?startapp=join${Math.abs(chatId)}`;
            res.json({ admins, invite_url });
        }
        catch (err) {
            logger_1.logger.error('GET /api/channel-admins failed', { err });
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
    async function resolveChannelInviteAccess(userId, joinChannelIdRaw) {
        if (!joinChannelIdRaw) {
            return { ok: false, status: 400, error: 'missing or invalid join_channel_id' };
        }
        const channelChatId = (0, resolveChannelChatId_1.resolveChannelChatIdFromInviteParam)(joinChannelIdRaw);
        if (channelChatId === null) {
            return { ok: false, status: 400, error: 'missing or invalid join_channel_id' };
        }
        const reg = channelRegistry_1.channelRegistry.getChannel(channelChatId);
        if (!reg) {
            return { ok: false, status: 404, error: 'channel is not connected to this bot' };
        }
        if (!(await (0, channelPostActions_1.isUserChannelAdmin)(deps.bot, channelChatId, userId))) {
            return { ok: false, status: 403, error: 'you must be a channel admin' };
        }
        return { ok: true, channelChatId, title: reg.title };
    }
    router.get('/channel-invite', async (req, res) => {
        const userId = parsePositiveInt(req.query.user_id);
        const joinChannelIdRaw = parseNonEmptyString(req.query.join_channel_id);
        if (!userId || !joinChannelIdRaw) {
            res.status(400).json({ error: 'missing user_id or join_channel_id' });
            return;
        }
        try {
            const access = await resolveChannelInviteAccess(userId, joinChannelIdRaw);
            if (!access.ok) {
                res.status(access.status).json({ error: access.error });
                return;
            }
            res.json({
                ok: true,
                channel_title: access.title,
                already_linked: channelNotifyLinkStore_1.channelNotifyLinkStore.isLinked(userId, access.channelChatId),
            });
        }
        catch (err) {
            logger_1.logger.error('GET /api/channel-invite failed', { err });
            res.status(500).json({ error: 'internal error' });
        }
    });
    router.post('/channel-invite', async (req, res) => {
        const body = req.body;
        if (!isRecord(body)) {
            res.status(400).json({ error: 'invalid body' });
            return;
        }
        const userId = parsePositiveInt(body.user_id);
        const joinChannelIdRaw = parseNonEmptyString(body.join_channel_id);
        if (!userId || !joinChannelIdRaw) {
            res.status(400).json({ error: 'missing user_id or join_channel_id' });
            return;
        }
        try {
            const access = await resolveChannelInviteAccess(userId, joinChannelIdRaw);
            if (!access.ok) {
                res.status(access.status).json({ error: access.error });
                return;
            }
            const wasLinked = channelNotifyLinkStore_1.channelNotifyLinkStore.isLinked(userId, access.channelChatId);
            channelNotifyLinkStore_1.channelNotifyLinkStore.register(userId, access.channelChatId);
            subscriberStore_1.subscriberStore.addSubscriber(userId);
            await channelNotifyLinkStore_1.channelNotifyLinkStore.forcePersist();
            res.json({
                ok: true,
                channel_title: access.title,
                already_linked: wasLinked,
            });
        }
        catch (err) {
            logger_1.logger.error('POST /api/channel-invite failed', { err });
            res.status(500).json({ error: 'internal error' });
        }
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
        const chatId = parseNonZeroInt(body.chat_id);
        const userId = parsePositiveInt(body.user_id);
        const username = parseNonEmptyString(body.username);
        const text = parseNonEmptyString(body.text);
        if (!postId || !chatId || !userId || !username || !text) {
            res.status(400).json({ error: 'missing or invalid fields' });
            return;
        }
        const post = postStore_1.postStore.getPost(postId);
        if (!post) {
            res.status(404).json({ error: 'post not found' });
            return;
        }
        if (post.chat_id !== chatId) {
            res.status(403).json({ error: 'Доступ запрещён' });
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
                commentId: saved.comment_id,
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
        const chatId = parseNonZeroInt(body.chat_id);
        const replierUserId = parsePositiveInt(body.user_id);
        const adminText = parseNonEmptyString(body.admin_text);
        if (!commentId || !postId || !chatId || !replierUserId || !adminText) {
            res.status(400).json({ error: 'missing or invalid fields' });
            return;
        }
        const rawAdminName = typeof body.admin_name === 'string' ? body.admin_name.trim() : '';
        const replierName = rawAdminName || 'Админ';
        const post = postStore_1.postStore.getPost(postId);
        if (!post || post.chat_id !== chatId) {
            res.status(404).json({ error: 'post not found' });
            return;
        }
        if (!(await (0, channelPostActions_1.isUserChannelAdmin)(deps.bot, post.chat_id, replierUserId))) {
            res.status(403).json({ error: 'Только администраторы могут отвечать' });
            return;
        }
        const existing = commentStore_1.commentStore.getComment(commentId);
        if (!existing || existing.post_id !== postId) {
            res.status(404).json({ error: 'comment not found' });
            return;
        }
        const updated = commentStore_1.commentStore.addReply(commentId, adminText, rawAdminName || undefined);
        if (!updated) {
            res.status(404).json({ error: 'comment not found' });
            return;
        }
        const mids = commentStore_1.commentStore.getNotificationMids(commentId);
        const originalText = updated.notification_text;
        if (mids.length > 0 && originalText && (0, postStore_1.isMiniAppOpenUrlConfigured)()) {
            const replyPreview = adminText.slice(0, 80);
            const ellipsis = adminText.length > 80 ? '...' : '';
            const statusLine = `\n\n✅ Ответил ${replierName}: «${replyPreview}${ellipsis}»`;
            const updatedText = `${originalText}${statusLine}`;
            const miniAppUrl = (0, postStore_1.buildMiniAppUrl)(postId, chatId, { admin: '1' });
            const kb = max_bot_api_1.Keyboard.inlineKeyboard([[max_bot_api_1.Keyboard.button.link('✅ Просмотрено', miniAppUrl)]]);
            for (const { admin_id, message_mid } of mids) {
                try {
                    await deps.bot.api.editMessage(message_mid, {
                        text: updatedText,
                        attachments: [kb],
                    });
                }
                catch (e) {
                    logger_1.logger.warn('Could not update notification message', { admin_id, message_mid, e });
                }
            }
        }
        else if (mids.length > 0 && !originalText) {
            logger_1.logger.warn('POST /api/reply: skip notification edit (missing notification_text)', { commentId });
        }
        await (0, notificationService_1.notifyUserAboutMiniappReply)(deps.bot, {
            userId: Number(updated.user_id),
            commentId: updated.comment_id,
            postText: post.text,
            userCommentText: updated.text,
            adminReplyText: adminText,
            postId,
            channelChatId: chatId,
        });
        res.json({ ok: true });
    });
    router.patch('/comment', async (req, res) => {
        const body = req.body;
        if (!isRecord(body)) {
            res.status(400).json({ error: 'invalid body' });
            return;
        }
        const commentId = parseNonEmptyString(body.comment_id);
        const postId = parseNonEmptyString(body.post_id);
        const chatId = parseNonZeroInt(body.chat_id);
        const editorUserId = parsePositiveInt(body.user_id);
        const text = parseNonEmptyString(body.text);
        if (!commentId || !postId || !chatId || !editorUserId || !text) {
            res.status(400).json({ error: 'missing or invalid fields' });
            return;
        }
        const access = await resolveAdminCommentAccess(deps.bot, {
            commentId,
            postId,
            chatId,
            userId: editorUserId,
        });
        if (!access.ok) {
            res.status(access.status).json({ error: access.error });
            return;
        }
        const updated = commentStore_1.commentStore.updateCommentText(commentId, text);
        if (!updated) {
            res.status(404).json({ error: 'comment not found' });
            return;
        }
        res.json(toWireComment(updated));
    });
    router.delete('/comment', async (req, res) => {
        const body = req.body;
        if (!isRecord(body)) {
            res.status(400).json({ error: 'invalid body' });
            return;
        }
        const commentId = parseNonEmptyString(body.comment_id);
        const postId = parseNonEmptyString(body.post_id);
        const chatId = parseNonZeroInt(body.chat_id);
        const editorUserId = parsePositiveInt(body.user_id);
        if (!commentId || !postId || !chatId || !editorUserId) {
            res.status(400).json({ error: 'missing or invalid fields' });
            return;
        }
        const access = await resolveAdminCommentAccess(deps.bot, {
            commentId,
            postId,
            chatId,
            userId: editorUserId,
        });
        if (!access.ok) {
            res.status(access.status).json({ error: access.error });
            return;
        }
        const removed = commentStore_1.commentStore.deleteComment(commentId);
        if (!removed) {
            res.status(404).json({ error: 'comment not found' });
            return;
        }
        const newCount = postStore_1.postStore.decrementCommentCount(postId);
        if (newCount !== null) {
            const updatedPost = postStore_1.postStore.getPost(postId);
            if (updatedPost) {
                await postStore_1.postStore.updateButtonCaption(deps.bot, updatedPost);
            }
        }
        res.json({ ok: true, comment_count: newCount });
    });
    router.patch('/reply', async (req, res) => {
        const body = req.body;
        if (!isRecord(body)) {
            res.status(400).json({ error: 'invalid body' });
            return;
        }
        const commentId = parseNonEmptyString(body.comment_id);
        const postId = parseNonEmptyString(body.post_id);
        const chatId = parseNonZeroInt(body.chat_id);
        const editorUserId = parsePositiveInt(body.user_id);
        const adminText = parseNonEmptyString(body.admin_text);
        if (!commentId || !postId || !chatId || !editorUserId || !adminText) {
            res.status(400).json({ error: 'missing or invalid fields' });
            return;
        }
        const rawAdminName = typeof body.admin_name === 'string' ? body.admin_name.trim() : '';
        const access = await resolveAdminCommentAccess(deps.bot, {
            commentId,
            postId,
            chatId,
            userId: editorUserId,
        });
        if (!access.ok) {
            res.status(access.status).json({ error: access.error });
            return;
        }
        const updated = commentStore_1.commentStore.updateReply(commentId, adminText, rawAdminName || undefined);
        if (!updated) {
            res.status(404).json({ error: 'reply not found' });
            return;
        }
        res.json(toWireComment(updated));
    });
    router.delete('/reply', async (req, res) => {
        const body = req.body;
        if (!isRecord(body)) {
            res.status(400).json({ error: 'invalid body' });
            return;
        }
        const commentId = parseNonEmptyString(body.comment_id);
        const postId = parseNonEmptyString(body.post_id);
        const chatId = parseNonZeroInt(body.chat_id);
        const editorUserId = parsePositiveInt(body.user_id);
        if (!commentId || !postId || !chatId || !editorUserId) {
            res.status(400).json({ error: 'missing or invalid fields' });
            return;
        }
        const access = await resolveAdminCommentAccess(deps.bot, {
            commentId,
            postId,
            chatId,
            userId: editorUserId,
        });
        if (!access.ok) {
            res.status(access.status).json({ error: access.error });
            return;
        }
        const updated = commentStore_1.commentStore.deleteReply(commentId);
        if (!updated) {
            res.status(404).json({ error: 'reply not found' });
            return;
        }
        res.json(toWireComment(updated));
    });
    return router;
}
//# sourceMappingURL=routes.js.map