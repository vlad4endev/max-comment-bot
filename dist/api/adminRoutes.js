"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAdminRouter = createAdminRouter;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const express_1 = __importDefault(require("express"));
const config_1 = require("../config");
const adminAuth_1 = require("../middleware/adminAuth");
const channelFullDisconnect_1 = require("../services/channelFullDisconnect");
const adminActivityStore_1 = require("../services/adminActivityStore");
const adminRuntimeSettingsStore_1 = require("../services/adminRuntimeSettingsStore");
const channelNotifyLinkStore_1 = require("../services/channelNotifyLinkStore");
const channelRegistry_1 = require("../services/channelRegistry");
const disabledAdminStore_1 = require("../services/disabledAdminStore");
const channelPoller_1 = require("../services/channelPoller");
const commentStore_1 = require("../services/commentStore");
const postStore_1 = require("../services/postStore");
const stateManager_1 = require("../services/stateManager");
const subscriberStore_1 = require("../services/subscriberStore");
const userAccessCleanup_1 = require("../services/userAccessCleanup");
const userMiniappSettingsStore_1 = require("../services/userMiniappSettingsStore");
const adminPanelSession_1 = require("../utils/adminPanelSession");
const adminPanelState_1 = require("./adminPanelState");
const analyticsService_1 = require("../services/analyticsService");
const logger_1 = require("../utils/logger");
const RUNTIME_LOG_PATH = (0, node_path_1.join)(process.cwd(), 'data', 'runtime.log');
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
function isChannelAdminOrOwnerMember(m) {
    return !m.is_bot && (m.is_admin || m.is_owner);
}
async function listChannelAdminsShort(bot, chatId) {
    try {
        const { members } = await bot.api.getChatAdmins(chatId);
        const admins = members.filter(isChannelAdminOrOwnerMember);
        if (admins.length > 0) {
            return [...new Map(admins.map((m) => [m.user_id, m])).values()].sort((a, b) => a.user_id - b.user_id);
        }
    }
    catch (err) {
        logger_1.logger.warn('admin listChannelAdminsShort: getChatAdmins failed', { chatId, err });
    }
    return [];
}
const REL_CHANNEL_ADMIN = 'Админ канала';
const REL_COMMENT_NOTIFY = 'Уведомления о комментариях';
function latestUsernameFromComments(userId) {
    for (const c of commentStore_1.commentStore.listAllCommentsNewestFirst()) {
        if (c.user_id === userId) {
            const u = c.username.trim();
            if (u !== '') {
                return u;
            }
        }
    }
    return null;
}
async function resolveDisplayNameFromMax(bot, userId, channelChatIds) {
    const ordered = [...new Set(channelChatIds)];
    for (const chatId of ordered) {
        try {
            const { members } = await bot.api.getChatMembers(chatId, { user_ids: [userId] });
            const m = members[0];
            const n = m?.name?.trim();
            if (n) {
                return n;
            }
        }
        catch (err) {
            logger_1.logger.debug('admin /users: getChatMembers for display name failed', { chatId, userId, err });
        }
    }
    const priv = stateManager_1.stateManager.getUserPrivateChatId(userId);
    if (priv !== undefined) {
        try {
            const { members } = await bot.api.getChatMembers(priv, { user_ids: [userId] });
            const n = members[0]?.name?.trim();
            if (n) {
                return n;
            }
        }
        catch (err) {
            logger_1.logger.debug('admin /users: getChatMembers private for display name failed', {
                priv,
                userId,
                err,
            });
        }
    }
    return null;
}
function createAdminRouter(deps) {
    const router = express_1.default.Router();
    router.use(express_1.default.json({ limit: '256kb' }));
    const secureCookie = config_1.config.NODE_ENV === 'production';
    const sessionMaxAgeSec = 7 * 24 * 60 * 60;
    router.post('/panel-login', (req, res) => {
        const body = req.body;
        const username = isRecord(body) ? parseNonEmptyString(body.username) : null;
        const password = isRecord(body) ? parseNonEmptyString(body.password) : null;
        if (!username || !password) {
            res.status(400).json({ error: 'invalid credentials' });
            return;
        }
        if (!(0, adminPanelSession_1.adminPanelCredentialsMatch)(username, password, config_1.config.adminPanelUser, config_1.config.adminPanelPassword)) {
            res.status(401).json({ error: 'invalid credentials' });
            return;
        }
        res.setHeader('Set-Cookie', (0, adminPanelSession_1.adminPanelSessionCookieHeader)(config_1.config.adminPanelSessionSecret, sessionMaxAgeSec, secureCookie));
        res.json({ ok: true });
    });
    router.post('/panel-logout', (_req, res) => {
        res.setHeader('Set-Cookie', (0, adminPanelSession_1.adminPanelLogoutCookieHeader)(secureCookie));
        res.json({ ok: true });
    });
    const secured = express_1.default.Router();
    secured.use(adminAuth_1.checkAdminAuth);
    secured.get('/settings', (_req, res) => {
        res.json({
            poll_interval_sec: adminRuntimeSettingsStore_1.adminRuntimeSettingsStore.getPollIntervalMs() / 1000,
            bot_nickname: config_1.config.BOT_NICKNAME,
            mini_app_url: config_1.config.miniAppUrl ?? null,
            admin_panel_user: config_1.config.adminPanelUser,
        });
    });
    secured.get('/stats', async (_req, res) => {
        await (0, channelFullDisconnect_1.pruneRegisteredChannelsNotAccessibleByBot)(deps.bot);
        const channels = channelRegistry_1.channelRegistry.getAllChannels().filter((c) => c.type === 'channel');
        res.json({
            channel_count: channels.length,
            bot_subscribers: subscriberStore_1.subscriberStore.getAllSubscribers().length,
            comment_count: commentStore_1.commentStore.totalCount,
            post_count: postStore_1.postStore.getTotalPostCount(),
        });
    });
    secured.get('/dashboard', async (req, res) => {
        await (0, channelFullDisconnect_1.pruneRegisteredChannelsNotAccessibleByBot)(deps.bot);
        const periodDays = (0, analyticsService_1.parseDashboardPeriodDays)(req.query.days);
        const payload = (0, analyticsService_1.buildDashboardAnalytics)(periodDays);
        res.json(payload);
    });
    secured.get('/channels', async (_req, res) => {
        const snapshot = [...channelRegistry_1.channelRegistry.getAllChannels()].filter((c) => c.type === 'channel');
        const rows = [];
        for (const c of snapshot) {
            if (channelRegistry_1.channelRegistry.getChannel(c.chat_id) === null) {
                continue;
            }
            let subscribers = null;
            try {
                const chat = await deps.bot.api.getChat(c.chat_id);
                const raw = chat.participants_count;
                if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
                    subscribers = raw;
                }
            }
            catch (err) {
                logger_1.logger.warn('admin GET /channels: getChat failed, pruning channel', { chatId: c.chat_id, err });
                await (0, channelFullDisconnect_1.fullyDisconnectRegisteredChannel)(deps.bot, c.chat_id, 'registry_stale_removed');
                continue;
            }
            const posts = postStore_1.postStore.getPostsByChatId(c.chat_id);
            const postIds = new Set(posts.map((p) => p.post_id));
            const commentCount = commentStore_1.commentStore.countForPostIds(postIds);
            const pending = stateManager_1.stateManager.isChannelPendingAdminRights(c.chat_id);
            rows.push({
                chat_id: c.chat_id,
                title: c.title,
                type: c.type,
                subscribers,
                post_count: posts.length,
                comment_count: commentCount,
                date_added: c.date_added,
                status: pending ? 'pending' : 'active',
            });
        }
        res.json({ channels: rows });
    });
    secured.get('/bot-status', (_req, res) => {
        res.json({ active: true, label: 'Бот активен' });
    });
    secured.get('/activity', (req, res) => {
        const limitRaw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 15;
        const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 15;
        const raw = (0, adminActivityStore_1.getRecentAdminActivity)(limit);
        const events = raw.map((ev) => {
            const chatId = typeof ev.payload.chat_id === 'number'
                ? ev.payload.chat_id
                : typeof ev.payload.channel_chat_id === 'number'
                    ? ev.payload.channel_chat_id
                    : null;
            const channelName = chatId !== null ? (channelRegistry_1.channelRegistry.getChannel(chatId)?.title ?? `Канал ${chatId}`) : null;
            let preview = null;
            if (typeof ev.payload.text === 'string') {
                preview = ev.payload.text;
            }
            else if (typeof ev.payload.username === 'string') {
                preview = ev.payload.username;
            }
            else if (typeof ev.payload.user_id === 'number') {
                preview = `user ${ev.payload.user_id}`;
            }
            return {
                type: ev.type,
                timestamp: ev.timestamp,
                channel_id: chatId,
                channel_name: channelName,
                preview,
                payload: ev.payload,
            };
        });
        res.json({ events });
    });
    secured.get('/users', async (_req, res) => {
        await (0, channelFullDisconnect_1.pruneRegisteredChannelsNotAccessibleByBot)(deps.bot);
        const ownerId = config_1.config.ownerUserId;
        const channels = channelRegistry_1.channelRegistry.getAllChannels().filter((ch) => ch.type === 'channel');
        const byUser = new Map();
        function touch(userId) {
            let row = byUser.get(userId);
            if (!row) {
                row = {
                    user_id: userId,
                    name: null,
                    role: 'subscriber',
                    linkByChatId: new Map(),
                    registered_at: null,
                    is_subscriber: false,
                    has_miniapp_settings: false,
                };
                byUser.set(userId, row);
            }
            return row;
        }
        function rowAddLinkRelation(row, chatId, title, relation) {
            let cell = row.linkByChatId.get(chatId);
            if (!cell) {
                cell = { title, relations: new Set() };
                row.linkByChatId.set(chatId, cell);
            }
            if (title) {
                cell.title = cell.title ?? title;
            }
            cell.relations.add(relation);
        }
        for (const uid of userMiniappSettingsStore_1.userMiniappSettingsStore.getAllUserIdsWithSettings()) {
            touch(uid).has_miniapp_settings = true;
        }
        for (const uid of subscriberStore_1.subscriberStore.getAllSubscribers()) {
            const row = touch(uid);
            row.is_subscriber = true;
        }
        for (const ch of channels) {
            let admins = [];
            try {
                admins = await listChannelAdminsShort(deps.bot, ch.chat_id);
            }
            catch (err) {
                logger_1.logger.warn('admin /users: channel admins failed', { chatId: ch.chat_id, err });
            }
            for (const m of admins) {
                const row = touch(m.user_id);
                if (m.name) {
                    row.name = row.name ?? m.name;
                }
                rowAddLinkRelation(row, ch.chat_id, ch.title, REL_CHANNEL_ADMIN);
                if (m.user_id === ownerId) {
                    row.role = 'owner';
                }
                else if (row.role !== 'owner') {
                    row.role = 'admin';
                }
            }
        }
        for (const link of channelNotifyLinkStore_1.channelNotifyLinkStore.getAllLinks()) {
            const row = touch(link.user_id);
            const title = channelRegistry_1.channelRegistry.getChannel(link.channel_chat_id)?.title ?? null;
            rowAddLinkRelation(row, link.channel_chat_id, title, REL_COMMENT_NOTIFY);
            row.is_subscriber = row.is_subscriber || subscriberStore_1.subscriberStore.hasSubscriber(link.user_id);
            if (row.registered_at === null) {
                row.registered_at = link.joined_at;
            }
            else if (link.joined_at.localeCompare(row.registered_at) < 0) {
                row.registered_at = link.joined_at;
            }
        }
        for (const row of byUser.values()) {
            if (row.user_id === ownerId) {
                row.role = 'owner';
            }
        }
        const rows = [...byUser.values()];
        for (const row of rows) {
            const chatIdsForName = [...row.linkByChatId.keys()].sort((a, b) => a - b);
            const existing = row.name?.trim();
            if (!existing) {
                const fromMax = await resolveDisplayNameFromMax(deps.bot, row.user_id, chatIdsForName);
                if (fromMax) {
                    row.name = fromMax;
                }
            }
            if (!row.name?.trim()) {
                const fromComments = latestUsernameFromComments(row.user_id);
                if (fromComments) {
                    row.name = fromComments;
                }
            }
        }
        const out = rows.map((row) => {
            const channel_links = [...row.linkByChatId.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([chat_id, v]) => ({
                chat_id,
                channel_title: v.title,
                relations: [...v.relations].sort((x, y) => x.localeCompare(y, 'ru')),
            }));
            let context_hint = null;
            if (row.linkByChatId.size === 0) {
                if (row.is_subscriber) {
                    context_hint =
                        'Подписчик бота (/start): привязка к каналу в боте не найдена (уведомления не включены или канал отключён)';
                }
                else if (row.has_miniapp_settings) {
                    context_hint =
                        'Открывали настройки мини-приложения: канал не привязан (нет ссылки уведомлений и нет прав админа в подключённых каналах)';
                }
            }
            return {
                user_id: row.user_id,
                name: row.name,
                role: row.role,
                /** @deprecated Используйте channel_links; оставлено для совместимости */
                channels: channel_links.map((l) => ({ chat_id: l.chat_id, title: l.channel_title })),
                channel_links,
                context_hint,
                registered_at: row.registered_at,
                avatar_url: null,
            };
        });
        out.sort((a, b) => a.user_id - b.user_id);
        res.json({ users: out });
    });
    secured.get('/comments', (req, res) => {
        const chatId = parseNonZeroInt(req.query.chat_id);
        if (chatId === null) {
            res.status(400).json({ error: 'missing or invalid chat_id' });
            return;
        }
        const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
        let list = commentStore_1.commentStore.listCommentsForChannelChatId(chatId);
        if (q !== '') {
            list = list.filter((c) => c.text.toLowerCase().includes(q) ||
                c.username.toLowerCase().includes(q) ||
                c.post_id.toLowerCase().includes(q));
        }
        const wired = list.map((c) => {
            const post = postStore_1.postStore.getPost(c.post_id);
            const postPreview = post?.text?.trim() ?? c.post_id;
            return {
                comment_id: c.comment_id,
                post_id: c.post_id,
                post_preview: postPreview,
                user_id: c.user_id,
                username: c.username,
                text: c.text,
                reply: c.reply,
                timestamp: c.timestamp,
            };
        });
        res.json({ comments: wired });
    });
    secured.post('/comments/delete', async (req, res) => {
        const body = req.body;
        const id = isRecord(body) ? parseNonEmptyString(body.comment_id) : null;
        if (!id) {
            res.status(400).json({ error: 'invalid comment_id' });
            return;
        }
        const removed = commentStore_1.commentStore.deleteComment(id);
        if (!removed) {
            res.status(404).json({ error: 'not found' });
            return;
        }
        void postStore_1.postStore.decrementCommentCount(removed.post_id);
        const post = postStore_1.postStore.getPost(removed.post_id);
        if (post) {
            try {
                await postStore_1.postStore.updateButtonCaption(deps.bot, post);
            }
            catch {
                /* ignore */
            }
        }
        res.json({ ok: true });
    });
    secured.get('/logs', async (req, res) => {
        const levelRaw = typeof req.query.level === 'string' ? req.query.level.toUpperCase() : '';
        const level = levelRaw === 'INFO' || levelRaw === 'WARN' || levelRaw === 'ERROR' ? levelRaw : null;
        const filter = typeof req.query.filter === 'string' ? req.query.filter.trim().toLowerCase() : '';
        const limitRaw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 200;
        const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 200;
        let lines = (0, logger_1.getAdminLogTail)(500);
        try {
            const file = await (0, promises_1.readFile)(RUNTIME_LOG_PATH, 'utf8');
            const fromFile = file.split(/\r?\n/).filter((l) => l.trim() !== '');
            if (fromFile.length > lines.length) {
                lines = fromFile.slice(-500);
            }
        }
        catch {
            /* use memory */
        }
        if (level) {
            lines = lines.filter((l) => l.includes(` [${level}] `));
        }
        if (filter) {
            lines = lines.filter((l) => l.toLowerCase().includes(filter));
        }
        res.json({ lines: lines.slice(-limit) });
    });
    secured.get('/channel/:chatId', async (req, res) => {
        const chatId = parseNonZeroInt(req.params.chatId);
        if (chatId === null) {
            res.status(400).json({ error: 'invalid chat_id' });
            return;
        }
        const ch = channelRegistry_1.channelRegistry.getChannel(chatId);
        if (!ch || ch.type !== 'channel') {
            res.status(404).json({ error: 'channel not found' });
            return;
        }
        const posts = postStore_1.postStore.getPostsByChatId(chatId);
        const postIds = new Set(posts.map((p) => p.post_id));
        const comments = commentStore_1.commentStore
            .listCommentsForChannelChatId(chatId)
            .slice(0, 5)
            .map((c) => ({
            comment_id: c.comment_id,
            username: c.username,
            text: c.text,
            timestamp: c.timestamp,
        }));
        const extras = await (0, adminPanelState_1.getChannelExtras)(chatId);
        const chains = (await (0, adminPanelState_1.listTgChains)()).filter((c) => c.max_chat_id === chatId);
        let subscribers = null;
        try {
            const chat = await deps.bot.api.getChat(chatId);
            const raw = chat.participants_count;
            if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
                subscribers = raw;
            }
        }
        catch {
            /* ignore */
        }
        res.json({
            channel: {
                chat_id: chatId,
                title: ch.title,
                status: stateManager_1.stateManager.isChannelPendingAdminRights(chatId) ? 'pending' : 'active',
                subscribers,
                post_count: posts.length,
                comment_count: commentStore_1.commentStore.countForPostIds(postIds),
                date_added: ch.date_added,
            },
            recent_comments: comments,
            settings: extras,
            tg_chain: chains[0] ?? null,
        });
    });
    secured.post('/channel/:chatId/settings', async (req, res) => {
        const chatId = parseNonZeroInt(req.params.chatId);
        if (chatId === null || !isRecord(req.body)) {
            res.status(400).json({ error: 'invalid request' });
            return;
        }
        const saved = await (0, adminPanelState_1.saveChannelExtras)(chatId, req.body);
        res.json({ ok: true, settings: saved });
    });
    secured.get('/antispam/words', async (_req, res) => {
        const data = await (0, adminPanelState_1.getAntispamWords)();
        const log = await (0, adminPanelState_1.getAntispamLog)(200);
        res.json({
            global: data.global,
            byChannel: data.byChannel,
            rules: data.rules,
            blocked_today: (0, adminPanelState_1.countAntispamBlocksToday)(log),
        });
    });
    secured.post('/antispam/words', async (req, res) => {
        if (!isRecord(req.body)) {
            res.status(400).json({ error: 'invalid body' });
            return;
        }
        const global = Array.isArray(req.body.global)
            ? req.body.global.filter((w) => typeof w === 'string')
            : undefined;
        const rules = isRecord(req.body.rules)
            ? req.body.rules
            : undefined;
        const rulesPatch = {};
        if (rules) {
            if (typeof rules.block_links === 'boolean')
                rulesPatch.block_links = rules.block_links;
            if (typeof rules.flood_protection === 'boolean') {
                rulesPatch.flood_protection = rules.flood_protection;
            }
            if (typeof rules.caps_protection === 'boolean') {
                rulesPatch.caps_protection = rules.caps_protection;
            }
            if (typeof rules.emoji_spam === 'boolean')
                rulesPatch.emoji_spam = rules.emoji_spam;
        }
        await (0, adminPanelState_1.saveAntispamWords)({
            global,
            rules: Object.keys(rulesPatch).length > 0 ? rulesPatch : undefined,
        });
        res.json({ ok: true });
    });
    secured.post('/antispam/channel/:chatId', async (req, res) => {
        const chatId = parseNonZeroInt(req.params.chatId);
        if (chatId === null || !isRecord(req.body)) {
            res.status(400).json({ error: 'invalid request' });
            return;
        }
        const body = req.body;
        const patch = {};
        if (Array.isArray(body.stopwords)) {
            patch.stopwords = body.stopwords.filter((w) => typeof w === 'string');
        }
        if (typeof body.block_links === 'boolean')
            patch.block_links = body.block_links;
        if (typeof body.flood_protection === 'boolean')
            patch.flood_protection = body.flood_protection;
        if (typeof body.auto_mute === 'boolean')
            patch.auto_mute = body.auto_mute;
        const saved = await (0, adminPanelState_1.saveChannelExtras)(chatId, patch);
        res.json({ ok: true, settings: saved });
    });
    secured.get('/antispam/log', async (req, res) => {
        const limitRaw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 50;
        const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
        const entries = await (0, adminPanelState_1.getAntispamLog)(limit);
        res.json({ entries });
    });
    secured.get('/tg-chains', async (_req, res) => {
        const chains = await (0, adminPanelState_1.listTgChains)();
        const active = chains.filter((c) => c.active).length;
        const forwardedToday = chains.reduce((s, c) => s + c.forwarded_today, 0);
        const errorsToday = chains.reduce((s, c) => s + c.errors_today, 0);
        res.json({ chains, stats: { active, forwarded_today: forwardedToday, errors_today: errorsToday } });
    });
    secured.post('/tg-chains', async (req, res) => {
        if (!isRecord(req.body)) {
            res.status(400).json({ error: 'invalid body' });
            return;
        }
        const maxChatId = parseNonZeroInt(req.body.max_chat_id);
        const tgUsername = parseNonEmptyString(req.body.tg_username);
        if (maxChatId === null || !tgUsername) {
            res.status(400).json({ error: 'max_chat_id and tg_username required' });
            return;
        }
        const ch = channelRegistry_1.channelRegistry.getChannel(maxChatId);
        const row = await (0, adminPanelState_1.createTgChain)({
            max_chat_id: maxChatId,
            max_title: ch?.title ?? null,
            tg_username: tgUsername.replace(/^@/, ''),
            bot_token: parseNonEmptyString(req.body.bot_token) ?? '',
            forward_posts: Boolean(req.body.forward_posts),
            forward_comments: Boolean(req.body.forward_comments),
            add_signature: Boolean(req.body.add_signature),
            active: true,
        });
        res.json({ ok: true, chain: row });
    });
    secured.patch('/tg-chains/:id', async (req, res) => {
        if (!isRecord(req.body)) {
            res.status(400).json({ error: 'invalid body' });
            return;
        }
        const id = parseNonEmptyString(req.params.id);
        if (!id) {
            res.status(400).json({ error: 'invalid id' });
            return;
        }
        const patch = {};
        if (typeof req.body.active === 'boolean')
            patch.active = req.body.active;
        if (typeof req.body.forward_posts === 'boolean')
            patch.forward_posts = req.body.forward_posts;
        if (typeof req.body.forward_comments === 'boolean')
            patch.forward_comments = req.body.forward_comments;
        const updated = await (0, adminPanelState_1.updateTgChain)(id, patch);
        if (!updated) {
            res.status(404).json({ error: 'not found' });
            return;
        }
        res.json({ ok: true, chain: updated });
    });
    secured.delete('/tg-chains/:id', async (req, res) => {
        const id = parseNonEmptyString(req.params.id);
        if (!id) {
            res.status(400).json({ error: 'invalid id' });
            return;
        }
        const ok = await (0, adminPanelState_1.deleteTgChain)(id);
        if (!ok) {
            res.status(404).json({ error: 'not found' });
            return;
        }
        res.json({ ok: true });
    });
    secured.get('/autoposts', async (_req, res) => {
        res.json({ posts: await (0, adminPanelState_1.listAutoposts)() });
    });
    secured.post('/autoposts', async (req, res) => {
        if (!isRecord(req.body)) {
            res.status(400).json({ error: 'invalid body' });
            return;
        }
        const chatId = parseNonZeroInt(req.body.chat_id);
        const text = parseNonEmptyString(req.body.text);
        const scheduledAt = parseNonEmptyString(req.body.scheduled_at);
        if (chatId === null || !text || !scheduledAt) {
            res.status(400).json({ error: 'chat_id, text, scheduled_at required' });
            return;
        }
        const repeatRaw = parseNonEmptyString(req.body.repeat) ?? 'none';
        const repeat = repeatRaw === 'daily' || repeatRaw === 'weekly' || repeatRaw === 'monthly' ? repeatRaw : 'none';
        const ch = channelRegistry_1.channelRegistry.getChannel(chatId);
        const row = await (0, adminPanelState_1.createAutopost)({
            chat_id: chatId,
            channel_title: ch?.title ?? null,
            text,
            scheduled_at: scheduledAt,
            repeat,
        });
        res.json({ ok: true, post: row });
    });
    secured.delete('/autoposts/:id', async (req, res) => {
        const id = parseNonEmptyString(req.params.id);
        if (!id) {
            res.status(400).json({ error: 'invalid id' });
            return;
        }
        const ok = await (0, adminPanelState_1.deleteAutopost)(id);
        if (!ok) {
            res.status(404).json({ error: 'not found' });
            return;
        }
        res.json({ ok: true });
    });
    secured.post('/refresh-buttons', async (req, res) => {
        const body = req.body;
        const chatId = isRecord(body) ? parseNonZeroInt(body.chat_id) : null;
        if (chatId === null) {
            res.status(400).json({ error: 'invalid chat_id' });
            return;
        }
        try {
            await (0, channelPoller_1.runChannelPollerForChat)(deps.bot, chatId);
            res.json({ ok: true });
        }
        catch (err) {
            logger_1.logger.error('admin refresh-buttons', err);
            res.status(500).json({ error: 'failed' });
        }
    });
    secured.post('/remove-channel', async (req, res) => {
        const body = req.body;
        const chatId = isRecord(body) ? parseNonZeroInt(body.chat_id) : null;
        if (chatId === null) {
            res.status(400).json({ error: 'invalid chat_id' });
            return;
        }
        await (0, channelFullDisconnect_1.fullyDisconnectRegisteredChannel)(deps.bot, chatId, 'manual_admin_panel');
        res.json({ ok: true });
    });
    secured.post('/settings', async (req, res) => {
        const body = req.body;
        if (!isRecord(body)) {
            res.status(400).json({ error: 'invalid body' });
            return;
        }
        const raw = body.poll_interval;
        let seconds = null;
        if (typeof raw === 'number' && Number.isFinite(raw)) {
            seconds = raw;
        }
        else if (typeof raw === 'string' && raw.trim() !== '') {
            seconds = Number.parseFloat(raw);
        }
        if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
            res.status(400).json({ error: 'invalid poll_interval (seconds)' });
            return;
        }
        const ms = Math.round(seconds * 1000);
        const applied = await adminRuntimeSettingsStore_1.adminRuntimeSettingsStore.setPollIntervalMs(ms);
        (0, channelPoller_1.restartChannelPostPoller)(deps.bot);
        res.json({
            ok: true,
            poll_interval_ms: applied,
            poll_interval_sec: applied / 1000,
        });
    });
    secured.post('/reset', (req, res) => {
        const body = req.body;
        const target = isRecord(body) && body.target === 'posts'
            ? 'posts'
            : isRecord(body) && body.target === 'subscribers'
                ? 'subscribers'
                : null;
        if (!target) {
            res.status(400).json({ error: 'target must be posts | subscribers' });
            return;
        }
        if (target === 'posts') {
            postStore_1.postStore.clearAllPosts();
            commentStore_1.commentStore.clearAllComments();
        }
        else {
            subscriberStore_1.subscriberStore.clearAllSubscribers();
        }
        res.json({ ok: true });
    });
    secured.post('/users/remove', (req, res) => {
        const body = req.body;
        const userId = isRecord(body) ? parsePositiveInt(body.user_id) : null;
        if (!userId) {
            res.status(400).json({ error: 'invalid user_id' });
            return;
        }
        if (userId === config_1.config.ownerUserId) {
            res.status(400).json({ error: 'cannot remove owner' });
            return;
        }
        disabledAdminStore_1.disabledAdminStore.disableUser(userId);
        (0, userAccessCleanup_1.fullyRemoveUserFromBot)(userId);
        res.json({ ok: true });
    });
    router.use(secured);
    return router;
}
//# sourceMappingURL=adminRoutes.js.map