"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCommentApiRouter = createCommentApiRouter;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = require("node:crypto");
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const config_1 = require("../config");
const deeplink_1 = require("../utils/deeplink");
const channelNotifyLinkStore_1 = require("../services/channelNotifyLinkStore");
const channelRegistry_1 = require("../services/channelRegistry");
const channelSettingsStore_1 = require("../services/channelSettingsStore");
const disabledAdminStore_1 = require("../services/disabledAdminStore");
const resolveChannelChatId_1 = require("../services/resolveChannelChatId");
const channelPostActions_1 = require("../services/channelPostActions");
const commentStore_1 = require("../services/commentStore");
const subscriberStore_1 = require("../services/subscriberStore");
const notificationService_1 = require("../services/notificationService");
const postStore_1 = require("../services/postStore");
const stateManager_1 = require("../services/stateManager");
const userMiniappSettingsStore_1 = require("../services/userMiniappSettingsStore");
const userAccessCleanup_1 = require("../services/userAccessCleanup");
const memberAvatar_1 = require("../utils/memberAvatar");
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
function parseOptionalString(value) {
    return typeof value === 'string' ? value.trim() : '';
}
/** NFKC: compatibility superscripts etc. → plain ASCII digits/letters for consistent rendering. */
function normalizeUserFacingText(value) {
    try {
        return value.normalize('NFKC');
    }
    catch {
        return value;
    }
}
function normalizePhotoUrl(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    if (trimmed.length > 2048) {
        return null;
    }
    return trimmed;
}
function parsePhotoUrls(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const out = [];
    for (const raw of value) {
        const normalized = normalizePhotoUrl(raw);
        if (normalized) {
            out.push(normalized);
        }
    }
    return [...new Set(out)].slice(0, 10);
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
    const replies = Array.isArray(c.replies) && c.replies.length > 0
        ? c.replies
        : c.reply
            ? [c.reply]
            : undefined;
    return {
        comment_id: c.comment_id,
        post_id: c.post_id,
        user_id: c.user_id,
        username: c.username,
        text: c.text,
        timestamp: c.timestamp,
        ...(c.avatar_url ? { avatar_url: c.avatar_url } : {}),
        ...(Array.isArray(c.photo_urls) && c.photo_urls.length > 0
            ? { photo_urls: c.photo_urls }
            : {}),
        ...(c.reply ? { reply: c.reply } : {}),
        ...(replies ? { replies } : {}),
    };
}
async function enrichCommentsWithAvatars(bot, channelChatId, comments) {
    const missingUserIds = new Set();
    for (const c of comments) {
        if (!c.avatar_url?.trim()) {
            missingUserIds.add(c.user_id);
        }
    }
    if (missingUserIds.size === 0) {
        return comments;
    }
    const urls = await (0, memberAvatar_1.resolveMemberAvatarUrls)(bot, channelChatId, [...missingUserIds]);
    if (urls.size === 0) {
        return comments;
    }
    for (const c of comments) {
        if (c.avatar_url?.trim()) {
            continue;
        }
        const url = urls.get(c.user_id);
        if (url) {
            commentStore_1.commentStore.setCommentAvatarUrl(c.comment_id, url);
            c.avatar_url = url;
        }
    }
    return comments;
}
function parseAdminModerationBody(body) {
    if (!isRecord(body)) {
        return null;
    }
    const commentId = parseNonEmptyString(body.comment_id);
    const postId = parseNonEmptyString(body.post_id);
    const chatId = parseNonZeroInt(body.chat_id);
    const userId = parsePositiveInt(body.user_id);
    if (!commentId || !postId || !chatId || !userId) {
        return null;
    }
    return { commentId, postId, chatId, userId };
}
function parseDisableChannelAdminBody(body) {
    if (!isRecord(body)) {
        return null;
    }
    const actorUserId = parsePositiveInt(body.user_id);
    const targetUserId = parsePositiveInt(body.target_user_id);
    const chatId = parseNonZeroInt(body.chat_id);
    if (!actorUserId || !targetUserId || !chatId) {
        return null;
    }
    return { actorUserId, targetUserId, chatId };
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
const MINIAPP_UPLOADS_PUBLIC_PREFIX = '/miniapp/uploads';
const MINIAPP_UPLOADS_DIR = node_path_1.default.join(process.cwd(), 'miniapp', 'uploads');
const MAX_UPLOAD_FILES = 10;
const MAX_UPLOAD_SIZE_BYTES = 8 * 1024 * 1024;
const miniappPhotoUpload = (0, multer_1.default)({
    storage: multer_1.default.diskStorage({
        destination(_req, _file, cb) {
            node_fs_1.default.mkdirSync(MINIAPP_UPLOADS_DIR, { recursive: true });
            cb(null, MINIAPP_UPLOADS_DIR);
        },
        filename(_req, file, cb) {
            const ext = node_path_1.default.extname(file.originalname || '').toLowerCase();
            const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg';
            cb(null, `${Date.now()}-${(0, node_crypto_1.randomUUID)()}${safeExt}`);
        },
    }),
    limits: {
        files: MAX_UPLOAD_FILES,
        fileSize: MAX_UPLOAD_SIZE_BYTES,
    },
    fileFilter(_req, file, cb) {
        if (!file.mimetype || !file.mimetype.startsWith('image/')) {
            cb(new Error('Можно загружать только изображения'));
            return;
        }
        cb(null, true);
    },
});
/**
 * Express router for Mini App REST API (`/api/...`).
 */
function createCommentApiRouter(deps) {
    const router = express_1.default.Router();
    router.use(express_1.default.json({ limit: '2mb' }));
    router.get('/config', (_req, res) => {
        res.json({
            bot_nickname: config_1.config.botNickname,
            /** Bump when join UI changes — helps verify deploy (grep join-heading in /miniapp/index.html). */
            miniapp_join_ui: 'admin-invite-v2',
        });
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
                let avatar_url = null;
                try {
                    const chat = await deps.bot.api.getChat(chatId);
                    const raw = chat.participants_count;
                    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
                        subscribers = raw;
                    }
                    const iconRaw = chat.icon?.url;
                    if (typeof iconRaw === 'string') {
                        const trimmed = iconRaw.trim();
                        if (trimmed) {
                            avatar_url = trimmed;
                        }
                    }
                }
                catch {
                    subscribers = null;
                    avatar_url = null;
                }
                const pending = stateManager_1.stateManager.isChannelPendingAdminRights(chatId);
                return {
                    chat_id: chatId,
                    title: reg?.title ?? null,
                    subscribers,
                    avatar_url,
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
            })).filter((a) => !disabledAdminStore_1.disabledAdminStore.isDisabled(a.user_id));
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
                        if (disabledAdminStore_1.disabledAdminStore.isDisabled(m.user_id)) {
                            continue;
                        }
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
            const invite_url = (0, deeplink_1.buildBotJoinUrl)(chatId);
            res.json({ admins, invite_url });
        }
        catch (err) {
            logger_1.logger.error('GET /api/channel-admins failed', { err });
            res.status(500).json({ error: 'internal error' });
        }
    });
    router.post('/channel-admins/disable', async (req, res) => {
        const input = parseDisableChannelAdminBody(req.body);
        if (!input) {
            res.status(400).json({ error: 'missing or invalid fields' });
            return;
        }
        const chatId = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(input.chatId);
        if (chatId === null || !channelRegistry_1.channelRegistry.getChannel(chatId)) {
            res.status(404).json({ error: 'channel not connected' });
            return;
        }
        if (input.targetUserId === config_1.config.ownerUserId) {
            res.status(400).json({ error: 'owner cannot be disabled' });
            return;
        }
        try {
            if (!(await (0, channelPostActions_1.isUserChannelAdmin)(deps.bot, chatId, input.actorUserId))) {
                res.status(403).json({ error: 'Доступ запрещён' });
                return;
            }
            if (!(await (0, channelPostActions_1.isUserChannelAdmin)(deps.bot, chatId, input.targetUserId))) {
                res.status(400).json({ error: 'target user is not a channel admin' });
                return;
            }
            disabledAdminStore_1.disabledAdminStore.disableUser(input.targetUserId);
            (0, userAccessCleanup_1.fullyRemoveUserFromBot)(input.targetUserId);
            res.json({ ok: true });
        }
        catch (err) {
            logger_1.logger.error('POST /api/channel-admins/disable failed', { err, chatId, input });
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
    router.get('/channel-settings', async (req, res) => {
        const chatIdRaw = parseNonZeroInt(req.query.chat_id);
        if (!chatIdRaw) {
            res.status(400).json({ error: 'missing or invalid chat_id' });
            return;
        }
        const chatId = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(chatIdRaw);
        if (chatId === null || !channelRegistry_1.channelRegistry.getChannel(chatId)) {
            res.status(404).json({ error: 'channel not connected' });
            return;
        }
        const fields = parseNonEmptyString(req.query.fields);
        const userId = parsePositiveInt(req.query.user_id);
        const managerOnly = fields === 'manager_url' || userId === null;
        if (managerOnly) {
            res.json({ manager_url: channelSettingsStore_1.channelSettingsStore.getManagerUrl(chatId) });
            return;
        }
        try {
            if (!(await (0, channelPostActions_1.isUserChannelAdmin)(deps.bot, chatId, userId))) {
                res.json({ manager_url: channelSettingsStore_1.channelSettingsStore.getManagerUrl(chatId) });
                return;
            }
            res.json(channelSettingsStore_1.channelSettingsStore.getSettings(chatId));
        }
        catch (err) {
            logger_1.logger.error('GET /api/channel-settings failed', { err, chatId });
            res.status(500).json({ error: 'internal error' });
        }
    });
    router.post('/channel-settings', async (req, res) => {
        const body = req.body;
        if (!isRecord(body)) {
            res.status(400).json({ error: 'invalid body' });
            return;
        }
        const userId = parsePositiveInt(body.user_id);
        const chatIdRaw = parseNonZeroInt(body.chat_id);
        if (!userId || !chatIdRaw) {
            res.status(400).json({ error: 'missing or invalid user_id or chat_id' });
            return;
        }
        const chatId = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(chatIdRaw);
        if (chatId === null || !channelRegistry_1.channelRegistry.getChannel(chatId)) {
            res.status(404).json({ error: 'channel not connected' });
            return;
        }
        if (!('manager_url' in body)) {
            res.status(400).json({ error: 'missing manager_url' });
            return;
        }
        const managerUrl = (0, channelSettingsStore_1.parseManagerUrlInput)(body.manager_url);
        if (managerUrl === 'invalid') {
            res.status(400).json({ error: 'invalid manager_url' });
            return;
        }
        try {
            if (!(await (0, channelPostActions_1.isUserChannelAdmin)(deps.bot, chatId, userId))) {
                res.status(403).json({ error: 'Доступ запрещён' });
                return;
            }
            const next = channelSettingsStore_1.channelSettingsStore.setManagerUrl(chatId, managerUrl);
            res.json(next);
        }
        catch (err) {
            logger_1.logger.error('POST /api/channel-settings failed', { err, chatId, userId });
            res.status(500).json({ error: 'internal error' });
        }
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
    function resolvePostForMiniApp(postId, chatIdRaw, messageMid) {
        const direct = postStore_1.postStore.getPost(postId);
        if (direct) {
            return direct;
        }
        if (chatIdRaw !== null && messageMid) {
            const byMid = postStore_1.postStore.findPostByChannelMessage(chatIdRaw, messageMid);
            if (byMid) {
                logger_1.logger.info('GET /post: resolved by message_mid', {
                    requestedPostId: postId,
                    postId: byMid.post_id,
                    chatId: chatIdRaw,
                    messageMid,
                });
                return byMid;
            }
        }
        return null;
    }
    router.get('/post/:postId', async (req, res) => {
        const chatIdRaw = parseNonZeroInt(req.query.chat_id);
        const messageMid = parseNonEmptyString(req.query.message_mid);
        const post = resolvePostForMiniApp(req.params.postId, chatIdRaw, messageMid);
        if (!post) {
            res.status(404).json({ error: 'post not found' });
            return;
        }
        const channel = channelRegistry_1.channelRegistry.getChannel(post.chat_id);
        let channel_avatar_url = null;
        try {
            const chat = await deps.bot.api.getChat(post.chat_id);
            const raw = chat.icon?.url;
            if (typeof raw === 'string') {
                const trimmed = raw.trim();
                if (trimmed) {
                    channel_avatar_url = trimmed;
                }
            }
        }
        catch (err) {
            logger_1.logger.warn('GET /post/:postId: getChat failed (channel avatar)', {
                chatId: post.chat_id,
                err,
            });
        }
        res.json({
            post_id: post.post_id,
            text: post.text,
            photo_url: post.photo_url ?? null,
            chat_id: post.chat_id,
            comment_count: post.comment_count,
            channel_title: channel?.title ?? null,
            channel_avatar_url,
        });
    });
    router.get('/comments/:postId', async (req, res) => {
        const postId = req.params.postId;
        const chatIdRaw = parseNonZeroInt(req.query.chat_id);
        const messageMid = parseNonEmptyString(req.query.message_mid);
        const post = resolvePostForMiniApp(postId, chatIdRaw, messageMid);
        if (!post) {
            res.status(404).json({ error: 'post not found' });
            return;
        }
        const resolvedPostId = post.post_id;
        try {
            const comments = commentStore_1.commentStore.getComments(resolvedPostId);
            const enriched = await enrichCommentsWithAvatars(deps.bot, post.chat_id, comments);
            res.json(enriched.map(toWireComment));
        }
        catch (err) {
            logger_1.logger.error('GET /api/comments/:postId failed', { postId: resolvedPostId, err });
            res.status(500).json({ error: 'internal error' });
        }
    });
    router.post('/upload-photos', (req, res) => {
        miniappPhotoUpload.array('photos', MAX_UPLOAD_FILES)(req, res, (err) => {
            if (err instanceof Error) {
                res.status(400).json({ error: err.message || 'Ошибка загрузки фото' });
                return;
            }
            const files = Array.isArray(req.files) ? req.files : [];
            const urls = files
                .map((f) => {
                const name = node_path_1.default.basename(f.filename);
                return `${MINIAPP_UPLOADS_PUBLIC_PREFIX}/${encodeURIComponent(name)}`;
            })
                .slice(0, MAX_UPLOAD_FILES);
            res.json({ photo_urls: urls });
        });
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
        const text = normalizeUserFacingText(parseOptionalString(body.text));
        const photoUrls = parsePhotoUrls(body.photo_urls);
        const avatarFromClient = parseNonEmptyString(body.avatar_url) ?? parseNonEmptyString(body.photo_url);
        if (!postId || !chatId || !userId || !username || (text === '' && photoUrls.length === 0)) {
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
        let avatarUrl = avatarFromClient;
        if (!avatarUrl) {
            const resolved = await (0, memberAvatar_1.resolveMemberAvatarUrls)(deps.bot, chatId, [userId]);
            avatarUrl = resolved.get(userId) ?? null;
        }
        const saved = commentStore_1.commentStore.saveComment({
            post_id: postId,
            user_id: userId,
            username,
            text,
            ...(photoUrls.length > 0 ? { photo_urls: photoUrls } : {}),
            ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
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
                commentPhotoUrls: photoUrls,
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
        const adminText = normalizeUserFacingText(parseOptionalString(body.admin_text));
        const replyPhotoUrls = parsePhotoUrls(body.photo_urls);
        if (!commentId || !postId || !chatId || !replierUserId || (adminText === '' && replyPhotoUrls.length === 0)) {
            res.status(400).json({ error: 'missing or invalid fields' });
            return;
        }
        const post = postStore_1.postStore.getPost(postId);
        if (!post || post.chat_id !== chatId) {
            res.status(404).json({ error: 'post not found' });
            return;
        }
        const channelReplyName = channelRegistry_1.channelRegistry.getChannel(chatId)?.title?.trim() || 'Канал';
        if (!(await (0, channelPostActions_1.isUserChannelAdmin)(deps.bot, post.chat_id, replierUserId))) {
            res.status(403).json({ error: 'Только администраторы могут отвечать' });
            return;
        }
        const replierNameForStatus = (await (0, memberAvatar_1.resolveMemberDisplayName)(deps.bot, post.chat_id, replierUserId)) ?? 'администратор';
        const existing = commentStore_1.commentStore.getComment(commentId);
        if (!existing || existing.post_id !== postId) {
            res.status(404).json({ error: 'comment not found' });
            return;
        }
        const updated = commentStore_1.commentStore.addReply(commentId, adminText, channelReplyName, replyPhotoUrls, replierNameForStatus);
        if (!updated) {
            res.status(404).json({ error: 'comment not found' });
            return;
        }
        try {
            await (0, notificationService_1.syncAdminCommentNotification)(deps.bot, updated, postId, chatId);
        }
        catch (err) {
            logger_1.logger.warn('POST /api/reply: sync admin notification failed', { commentId, err });
        }
        await (0, notificationService_1.notifyUserAboutMiniappReply)(deps.bot, {
            userId: Number(updated.user_id),
            commentId: updated.comment_id,
            postText: post.text,
            userCommentText: updated.text,
            adminReplyText: adminText,
            adminReplyPhotoUrls: replyPhotoUrls,
            postId,
            channelChatId: chatId,
        });
        const [enriched] = await enrichCommentsWithAvatars(deps.bot, chatId, [updated]);
        res.json(toWireComment(enriched ?? updated));
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
        const rawText = parseNonEmptyString(body.text);
        const text = rawText != null ? normalizeUserFacingText(rawText) : null;
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
    const adminDeleteComment = async (res, input) => {
        const access = await resolveAdminCommentAccess(deps.bot, {
            commentId: input.commentId,
            postId: input.postId,
            chatId: input.chatId,
            userId: input.userId,
        });
        if (!access.ok) {
            res.status(access.status).json({ error: access.error });
            return;
        }
        const removed = commentStore_1.commentStore.deleteComment(input.commentId);
        if (!removed) {
            res.status(404).json({ error: 'comment not found' });
            return;
        }
        const newCount = postStore_1.postStore.decrementCommentCount(input.postId);
        res.json({ ok: true, comment_count: newCount });
        if (newCount !== null) {
            const updatedPost = postStore_1.postStore.getPost(input.postId);
            if (updatedPost) {
                void postStore_1.postStore.updateButtonCaption(deps.bot, updatedPost).catch((err) => {
                    logger_1.logger.warn('adminDeleteComment: updateButtonCaption failed after response', {
                        postId: input.postId,
                        err,
                    });
                });
            }
        }
    };
    router.delete('/comment', async (req, res) => {
        const input = parseAdminModerationBody(req.body);
        if (!input) {
            res.status(400).json({ error: 'missing or invalid fields' });
            return;
        }
        await adminDeleteComment(res, input);
    });
    router.post('/comment/delete', async (req, res) => {
        const input = parseAdminModerationBody(req.body);
        if (!input) {
            res.status(400).json({ error: 'missing or invalid fields' });
            return;
        }
        await adminDeleteComment(res, input);
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
        const adminText = normalizeUserFacingText(parseOptionalString(body.admin_text));
        const photoUrlsInBody = 'photo_urls' in body;
        const replyPhotoUrls = photoUrlsInBody ? parsePhotoUrls(body.photo_urls) : undefined;
        if (!commentId ||
            !postId ||
            !chatId ||
            !editorUserId ||
            (adminText === '' &&
                !(replyPhotoUrls !== undefined
                    ? replyPhotoUrls.length > 0
                    : !!(commentStore_1.commentStore.getComment(commentId)?.reply?.photo_urls?.length)))) {
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
        const channelReplyName = channelRegistry_1.channelRegistry.getChannel(access.post.chat_id)?.title?.trim() || 'Канал';
        const updated = commentStore_1.commentStore.updateReply(commentId, adminText, channelReplyName, replyPhotoUrls);
        if (!updated) {
            res.status(404).json({ error: 'reply not found' });
            return;
        }
        try {
            await (0, notificationService_1.syncAdminCommentNotification)(deps.bot, updated, postId, chatId);
        }
        catch (err) {
            logger_1.logger.warn('PATCH /api/reply: sync admin notification failed', { commentId, err });
        }
        res.json(toWireComment(updated));
    });
    const adminDeleteReply = async (res, input) => {
        const access = await resolveAdminCommentAccess(deps.bot, {
            commentId: input.commentId,
            postId: input.postId,
            chatId: input.chatId,
            userId: input.userId,
        });
        if (!access.ok) {
            res.status(access.status).json({ error: access.error });
            return;
        }
        const updated = commentStore_1.commentStore.deleteReply(input.commentId);
        if (!updated) {
            res.status(404).json({ error: 'reply not found' });
            return;
        }
        try {
            await (0, notificationService_1.syncAdminCommentNotification)(deps.bot, updated, input.postId, input.chatId);
        }
        catch (err) {
            logger_1.logger.warn('DELETE /api/reply: sync admin notification failed', {
                commentId: input.commentId,
                err,
            });
        }
        res.json(toWireComment(updated));
    };
    router.delete('/reply', async (req, res) => {
        const input = parseAdminModerationBody(req.body);
        if (!input) {
            res.status(400).json({ error: 'missing or invalid fields' });
            return;
        }
        await adminDeleteReply(res, input);
    });
    router.post('/reply/delete', async (req, res) => {
        const input = parseAdminModerationBody(req.body);
        if (!input) {
            res.status(400).json({ error: 'missing or invalid fields' });
            return;
        }
        await adminDeleteReply(res, input);
    });
    return router;
}
//# sourceMappingURL=routes.js.map