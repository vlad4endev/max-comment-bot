"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAdminRouter = createAdminRouter;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const express_1 = __importDefault(require("express"));
const p_limit_1 = __importDefault(require("p-limit"));
const config_1 = require("../config");
const adminAuth_1 = require("../middleware/adminAuth");
const commentSyncFilter_1 = require("../utils/commentSyncFilter");
const channelFullDisconnect_1 = require("../services/channelFullDisconnect");
const adminActivityStore_1 = require("../services/adminActivityStore");
const adminRuntimeSettingsStore_1 = require("../services/adminRuntimeSettingsStore");
const channelNotifyLinkStore_1 = require("../services/channelNotifyLinkStore");
const channelRegistry_1 = require("../services/channelRegistry");
const disabledAdminStore_1 = require("../services/disabledAdminStore");
const channelPoller_1 = require("../services/channelPoller");
const channelPostActions_1 = require("../services/channelPostActions");
const commentStore_1 = require("../services/commentStore");
const postLinkAutoRecovery_1 = require("../services/postLinkAutoRecovery");
const postLinkDiagnostics_1 = require("../services/postLinkDiagnostics");
const postStore_1 = require("../services/postStore");
const stateManager_1 = require("../services/stateManager");
const subscriberStore_1 = require("../services/subscriberStore");
const channelSubscriberSnapshotStore_1 = require("../services/channelSubscriberSnapshotStore");
const userAccessCleanup_1 = require("../services/userAccessCleanup");
const userMiniappSettingsStore_1 = require("../services/userMiniappSettingsStore");
const adminPanelSession_1 = require("../utils/adminPanelSession");
const adminPanelState_1 = require("./adminPanelState");
const autopostRoutes_1 = require("./autopostRoutes");
const analyticsService_1 = require("../services/analyticsService");
const integrationsStore_1 = require("../services/integrationsStore");
const adminLogFormat_1 = require("../utils/adminLogFormat");
const tgChainChannelRef_1 = require("../services/tgChainChannelRef");
const integrationPlatformClient_1 = require("../services/integrationPlatformClient");
const mtprotoConfigStore_1 = require("../services/mtprotoConfigStore");
const tgChainPair_1 = require("../utils/tgChainPair");
const logger_1 = require("../utils/logger");
const memberAvatar_1 = require("../utils/memberAvatar");
const seedAntispamScoredWords_1 = require("../db/seedAntispamScoredWords");
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
function parseBoolean(value) {
    if (typeof value === 'boolean') {
        return value;
    }
    return null;
}
function parseTgDiscussionChatId(value) {
    if (value === null || value === '') {
        return null;
    }
    const raw = parseNonEmptyString(value);
    if (!raw) {
        return undefined;
    }
    const normalized = raw.replace(/^@/, '');
    if (!/^-?\d+$/.test(normalized)) {
        return undefined;
    }
    return normalized;
}
function parseDiscussionSendAs(value) {
    if (value === 'channel' || value === 'chat') {
        return value;
    }
    return undefined;
}
function parseCommentSyncKeywords(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    return value
        .filter((w) => typeof w === 'string')
        .map((w) => w.trim())
        .filter(Boolean);
}
function parseCommentSyncMatchMode(value) {
    if (typeof value !== 'string') {
        return undefined;
    }
    return (0, commentSyncFilter_1.normalizeCommentSyncMatchMode)(value);
}
function extractChatAvatarUrl(chat) {
    const icon = chat.icon;
    const iconRaw = icon && typeof icon === 'object' ? icon.url : undefined;
    if (typeof iconRaw !== 'string') {
        return null;
    }
    const trimmed = iconRaw.trim();
    return trimmed === '' ? null : trimmed;
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
const REL_CHANNEL_SUBSCRIBER = 'Подписчик канала';
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
async function resolveAvatarFromMax(bot, userId, channelChatIds) {
    const ordered = [...new Set(channelChatIds)];
    for (const chatId of ordered) {
        try {
            const { members } = await bot.api.getChatMembers(chatId, { user_ids: [userId] });
            const avatarUrl = (0, memberAvatar_1.extractMemberAvatarUrl)(members[0]);
            if (avatarUrl) {
                return avatarUrl;
            }
        }
        catch (err) {
            logger_1.logger.debug('admin /users: getChatMembers for avatar failed', { chatId, userId, err });
        }
    }
    const priv = stateManager_1.stateManager.getUserPrivateChatId(userId);
    if (priv !== undefined) {
        try {
            const { members } = await bot.api.getChatMembers(priv, { user_ids: [userId] });
            const avatarUrl = (0, memberAvatar_1.extractMemberAvatarUrl)(members[0]);
            if (avatarUrl) {
                return avatarUrl;
            }
        }
        catch (err) {
            logger_1.logger.debug('admin /users: getChatMembers private for avatar failed', {
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
    secured.get('/stats', (_req, res) => {
        const channels = channelRegistry_1.channelRegistry.getAllChannels().filter((c) => c.type === 'channel');
        res.json({
            channel_count: channels.length,
            bot_subscribers: subscriberStore_1.subscriberStore.getAllSubscribers().length,
            comment_count: commentStore_1.commentStore.totalCount,
            post_count: postStore_1.postStore.getTotalPostCount(),
        });
    });
    secured.get('/dashboard', (req, res) => {
        const periodDays = (0, analyticsService_1.parseDashboardPeriodDays)(req.query.days);
        const payload = (0, analyticsService_1.buildDashboardAnalytics)(periodDays);
        res.json(payload);
    });
    secured.get('/dashboard-telegram', async (_req, res) => {
        await integrationsStore_1.integrationsStore.load();
        const integ = integrationsStore_1.integrationsStore.getTelegramIntegration();
        const channels = integ?.linkedChats ?? [];
        const flows = integrationsStore_1.integrationsStore.getFlows().filter((f) => f.source.platform === 'telegram');
        const flowsActive = flows.filter((f) => f.enabled).length;
        const forwardedLog = integrationsStore_1.integrationsStore.getForwardedLog(50);
        const tgForwarded = forwardedLog.filter((e) => e.fromPlatform === 'telegram');
        res.json({
            totals: {
                channels: channels.length,
                channels_admin: channels.filter((c) => c.botIsAdmin === true).length,
                admins_total: 0,
                admins_started: 0,
                flows_active: flowsActive,
                forwarded_total: tgForwarded.length,
            },
            channels: channels.map((ch) => ({
                id: ch.id,
                title: ch.title,
                username: ch.username,
                type: ch.type,
                botIsAdmin: ch.botIsAdmin === true,
                admins: [],
                admins_total: 0,
                admins_started: 0,
            })),
            recent_forwarded: tgForwarded.slice(0, 15),
        });
    });
    secured.get('/channels', async (req, res) => {
        const summaryOnly = req.query.summary === '1' || req.query.summary === 'true';
        if (summaryOnly) {
            const snapshot = channelRegistry_1.channelRegistry.getAllChannels().filter((c) => c.type === 'channel');
            res.json({
                channels: snapshot.map((c) => ({
                    chat_id: c.chat_id,
                    title: c.title,
                    status: stateManager_1.stateManager.isChannelPendingAdminRights(c.chat_id) ? 'pending' : 'active',
                })),
            });
            return;
        }
        await (0, channelFullDisconnect_1.maybePruneRegisteredChannelsNotAccessibleByBot)(deps.bot);
        const snapshot = [...channelRegistry_1.channelRegistry.getAllChannels()].filter((c) => c.type === 'channel');
        const limit = (0, p_limit_1.default)(4);
        const rows = await Promise.all(snapshot.map((c) => limit(async () => {
            if (channelRegistry_1.channelRegistry.getChannel(c.chat_id) === null) {
                return null;
            }
            const pending = stateManager_1.stateManager.isChannelPendingAdminRights(c.chat_id);
            let subscribers = null;
            let avatar_url = null;
            try {
                const chat = await deps.bot.api.getChat(c.chat_id);
                avatar_url = extractChatAvatarUrl(chat);
                const raw = chat.participants_count;
                if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
                    subscribers = raw;
                }
            }
            catch (err) {
                logger_1.logger.warn('admin GET /channels: getChat failed', { chatId: c.chat_id, err });
                return null;
            }
            return {
                chat_id: c.chat_id,
                title: c.title,
                type: c.type,
                subscribers,
                post_count: postStore_1.postStore.countPostsByChatId(c.chat_id),
                comment_count: commentStore_1.commentStore.countCommentsByChatId(c.chat_id),
                date_added: c.date_added,
                status: pending ? 'pending' : 'active',
                avatar_url,
            };
        })));
        res.json({ channels: rows.filter((row) => row !== null) });
    });
    secured.get('/bot-status', async (_req, res) => {
        await integrationsStore_1.integrationsStore.load();
        const tgInteg = integrationsStore_1.integrationsStore.getTelegramIntegration();
        const vkInteg = integrationsStore_1.integrationsStore
            .getIntegrations()
            .find((i) => i.platform === 'vk' && i.status === 'connected');
        const tgToken = (tgInteg?.token?.trim() || (0, config_1.getTelegramToken)()).trim();
        const tgChains = await (0, adminPanelState_1.listTgChains)();
        const vkChains = await (0, adminPanelState_1.listVkChains)();
        const tgLinked = tgInteg?.linkedChats ?? [];
        res.json({
            active: true,
            label: 'MAX бот активен',
            platforms: {
                max: { active: true, label: 'MAX бот' },
                telegram: {
                    connected: Boolean(tgInteg && tgToken),
                    has_token: Boolean(tgToken),
                    label: tgInteg && tgToken ? 'Telegram подключён' : 'Telegram не подключён',
                    chains_active: tgChains.filter((c) => c.active).length,
                    channels_total: tgLinked.length,
                    channels_admin: tgLinked.filter((c) => c.botIsAdmin === true).length,
                },
                vk: {
                    connected: Boolean(vkInteg),
                    label: vkInteg ? 'VK подключён' : 'VK не подключён',
                    chains_active: vkChains.filter((c) => c.active).length,
                },
            },
            mtproto_ready: (0, mtprotoConfigStore_1.isMtprotoSessionReady)(),
        });
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
        await (0, channelFullDisconnect_1.maybePruneRegisteredChannelsNotAccessibleByBot)(deps.bot);
        const ownerId = config_1.config.ownerUserId;
        const commentStatsByUser = commentStore_1.commentStore.aggregateUserCommentStats();
        const snapshotMembers = channelSubscriberSnapshotStore_1.channelSubscriberSnapshotStore.listAllMembers();
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
                    avatar_url: null,
                    comments_total: 0,
                    comments_answered: 0,
                    comments_unanswered: 0,
                    last_comment_at: null,
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
        for (const member of snapshotMembers) {
            const row = touch(member.user_id);
            if (!row.name?.trim()) {
                row.name = member.name;
            }
            if (!row.avatar_url && member.avatar_url) {
                row.avatar_url = member.avatar_url;
            }
            const title = channelRegistry_1.channelRegistry.getChannel(member.channel_chat_id)?.title ?? null;
            rowAddLinkRelation(row, member.channel_chat_id, title, REL_CHANNEL_SUBSCRIBER);
            if (member.is_admin || member.is_owner) {
                rowAddLinkRelation(row, member.channel_chat_id, title, REL_CHANNEL_ADMIN);
                if (member.user_id === ownerId) {
                    row.role = 'owner';
                }
                else if (row.role !== 'owner') {
                    row.role = 'admin';
                }
            }
        }
        for (const [userId, stats] of commentStatsByUser) {
            const row = touch(userId);
            row.comments_total = stats.total;
            row.comments_answered = stats.answered;
            row.comments_unanswered = stats.unanswered;
            row.last_comment_at = stats.last_comment_at;
            if (!row.avatar_url && stats.latest_avatar_url) {
                row.avatar_url = stats.latest_avatar_url;
            }
            if (!row.name?.trim() && stats.latest_username) {
                row.name = stats.latest_username;
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
        const out = [...byUser.values()].map((row) => {
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
                started_bot: row.is_subscriber,
                is_restricted: disabledAdminStore_1.disabledAdminStore.isDisabled(row.user_id),
                /** @deprecated Используйте channel_links; оставлено для совместимости */
                channels: channel_links.map((l) => ({ chat_id: l.chat_id, title: l.channel_title })),
                channel_links,
                context_hint,
                registered_at: row.registered_at,
                avatar_url: row.avatar_url,
                comment_stats: {
                    total: row.comments_total,
                    answered: row.comments_answered,
                    unanswered: row.comments_unanswered,
                    last_comment_at: row.last_comment_at,
                },
            };
        });
        out.sort((a, b) => a.user_id - b.user_id);
        res.json({ users: out });
    });
    secured.get('/users/:userId', async (req, res) => {
        const userId = parsePositiveInt(req.params.userId);
        if (!userId) {
            res.status(400).json({ error: 'invalid user_id' });
            return;
        }
        await (0, channelFullDisconnect_1.maybePruneRegisteredChannelsNotAccessibleByBot)(deps.bot);
        const ownerId = config_1.config.ownerUserId;
        const links = channelNotifyLinkStore_1.channelNotifyLinkStore.getAllLinks().filter((link) => link.user_id === userId);
        const channelsWithAdminRole = channelRegistry_1.channelRegistry.getAllChannels().filter((channel) => channel.type === 'channel');
        const commentsRaw = commentStore_1.commentStore.listAllCommentsNewestFirst().filter((c) => c.user_id === userId);
        const channelLinksById = new Map();
        function addChannelRelation(chatId, title, relation) {
            let row = channelLinksById.get(chatId);
            if (!row) {
                row = { title, relations: new Set() };
                channelLinksById.set(chatId, row);
            }
            if (title && !row.title) {
                row.title = title;
            }
            row.relations.add(relation);
        }
        for (const link of links) {
            const title = channelRegistry_1.channelRegistry.getChannel(link.channel_chat_id)?.title ?? null;
            addChannelRelation(link.channel_chat_id, title, REL_COMMENT_NOTIFY);
        }
        for (const member of channelSubscriberSnapshotStore_1.channelSubscriberSnapshotStore.listMembersForUser(userId)) {
            const title = channelRegistry_1.channelRegistry.getChannel(member.channel_chat_id)?.title ?? null;
            addChannelRelation(member.channel_chat_id, title, REL_CHANNEL_SUBSCRIBER);
        }
        for (const ch of channelsWithAdminRole) {
            try {
                const { members } = await deps.bot.api.getChatMembers(ch.chat_id, { user_ids: [userId] });
                const m = members[0];
                if (m && !m.is_bot && (m.is_admin || m.is_owner)) {
                    addChannelRelation(ch.chat_id, ch.title, REL_CHANNEL_ADMIN);
                }
            }
            catch (err) {
                logger_1.logger.debug('admin /users/:userId getChatMembers failed', { chatId: ch.chat_id, userId, err });
            }
        }
        const isSubscriber = subscriberStore_1.subscriberStore.hasSubscriber(userId);
        const hasMiniappSettings = userMiniappSettingsStore_1.userMiniappSettingsStore
            .getAllUserIdsWithSettings()
            .includes(userId);
        if (channelLinksById.size === 0 &&
            !isSubscriber &&
            !hasMiniappSettings &&
            commentsRaw.length === 0 &&
            userId !== ownerId) {
            res.status(404).json({ error: 'user not found' });
            return;
        }
        const channelIds = [...channelLinksById.keys()].sort((a, b) => a - b);
        const avatarFromComment = commentsRaw.find((c) => c.avatar_url?.trim())?.avatar_url?.trim() ?? null;
        let name = commentsRaw.find((c) => c.username.trim())?.username.trim() ?? null;
        const fromMaxName = await resolveDisplayNameFromMax(deps.bot, userId, channelIds);
        if (fromMaxName) {
            name = fromMaxName;
        }
        let avatarUrl = avatarFromComment;
        if (!avatarUrl) {
            avatarUrl = await resolveAvatarFromMax(deps.bot, userId, channelIds);
        }
        let registeredAt = null;
        for (const link of links) {
            if (!registeredAt || link.joined_at.localeCompare(registeredAt) < 0) {
                registeredAt = link.joined_at;
            }
        }
        const channel_links = [...channelLinksById.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([chat_id, value]) => ({
            chat_id,
            channel_title: value.title,
            relations: [...value.relations].sort((x, y) => x.localeCompare(y, 'ru')),
        }));
        const hasAdminRelation = channel_links.some((link) => link.relations.includes(REL_CHANNEL_ADMIN));
        const comments = commentsRaw.map((c) => {
            const post = postStore_1.postStore.getPost(c.post_id);
            const answered = Boolean(c.reply?.text?.trim());
            return {
                comment_id: c.comment_id,
                post_id: c.post_id,
                text: c.text,
                timestamp: c.timestamp,
                status: answered ? 'answered' : 'unanswered',
                reply: answered
                    ? {
                        text: c.reply.text,
                        timestamp: c.reply.timestamp,
                        admin_name: c.reply.admin_name ?? null,
                    }
                    : null,
                post_context: post
                    ? {
                        chat_id: post.chat_id,
                        channel_title: channelRegistry_1.channelRegistry.getChannel(post.chat_id)?.title ?? null,
                        text: post.text,
                        photo_url: post.photo_url ?? null,
                        channel_post_url: post.channel_post_url ?? null,
                        timestamp: post.timestamp,
                    }
                    : null,
            };
        });
        const answeredComments = comments.filter((c) => c.status === 'answered');
        const unansweredComments = comments.filter((c) => c.status === 'unanswered');
        res.json({
            user: {
                user_id: userId,
                name,
                role: userId === ownerId
                    ? 'owner'
                    : hasAdminRelation
                        ? 'admin'
                        : 'subscriber',
                is_restricted: disabledAdminStore_1.disabledAdminStore.isDisabled(userId),
                channel_links,
                context_hint: channel_links.length === 0 && isSubscriber
                    ? 'Подписчик бота (/start): привязка к каналу не найдена'
                    : channel_links.length === 0 && hasMiniappSettings
                        ? 'Пользователь открывал мини-приложение, но не привязан к каналу'
                        : null,
                registered_at: registeredAt,
                avatar_url: avatarUrl,
                comment_stats: {
                    total: comments.length,
                    answered: answeredComments.length,
                    unanswered: unansweredComments.length,
                    last_comment_at: comments[0]?.timestamp ?? null,
                },
                is_subscriber: isSubscriber,
                started_bot: isSubscriber,
                has_miniapp_settings: hasMiniappSettings,
                private_chat_id: stateManager_1.stateManager.getUserPrivateChatId(userId) ?? null,
            },
            comments: {
                answered: answeredComments,
                unanswered: unansweredComments,
                total: comments.length,
            },
        });
    });
    secured.post('/users/sync-channel-subscribers', async (_req, res) => {
        try {
            await (0, channelFullDisconnect_1.maybePruneRegisteredChannelsNotAccessibleByBot)(deps.bot, { force: true });
            const result = await channelSubscriberSnapshotStore_1.channelSubscriberSnapshotStore.syncAllRegisteredChannels(deps.bot);
            res.json({ ok: true, ...result });
        }
        catch (err) {
            logger_1.logger.error('admin /users/sync-channel-subscribers failed', err);
            res.status(500).json({ error: 'failed to sync channel subscribers' });
        }
    });
    secured.get('/comments', (req, res) => {
        const chatId = parseNonZeroInt(req.query.chat_id);
        if (chatId === null) {
            res.status(400).json({ error: 'missing or invalid chat_id' });
            return;
        }
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        const limitRaw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 100;
        const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 100;
        const rows = commentStore_1.commentStore.listCommentsForChannelAdminPage(chatId, { limit, q });
        const totalInChannel = commentStore_1.commentStore.countCommentsByChatId(chatId);
        const wired = rows.map(({ comment: c, post_preview }) => ({
            comment_id: c.comment_id,
            post_id: c.post_id,
            post_preview,
            user_id: c.user_id,
            username: c.username,
            text: c.text,
            reply: c.reply,
            timestamp: c.timestamp,
        }));
        res.json({
            comments: wired,
            total_in_channel: totalInChannel,
            returned: wired.length,
            truncated: totalInChannel > wired.length,
        });
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
    secured.get('/db-stats', (_req, res) => {
        try {
            const db = require('../db/database').getDb();
            const posts = db.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
            const pendingButtons = db.prepare("SELECT COUNT(*) AS n FROM posts WHERE json_extract(data, '$.button_attach_pending') = 1").get().n;
            const channels = db.prepare('SELECT COUNT(*) AS n FROM channels WHERE active = 1').get().n;
            const comments = db.prepare('SELECT COUNT(*) AS n FROM comments').get().n;
            const subscribers = db.prepare('SELECT COUNT(*) AS n FROM subscribers').get().n;
            const retryQueueSize = require('../services/commentButtonRetryQueue').getCommentButtonRetryQueueSize();
            const autoRecovery = (0, postLinkAutoRecovery_1.getPostLinkAutoRecoveryStats)();
            res.json({
                posts,
                pending_buttons: pendingButtons,
                channels,
                comments,
                subscribers,
                retry_queue: retryQueueSize,
                auto_recovery: autoRecovery,
            });
        }
        catch (err) {
            logger_1.logger.error('admin /db-stats failed', err);
            res.status(500).json({ error: 'internal error' });
        }
    });
    secured.get('/logs', async (req, res) => {
        const levelRaw = typeof req.query.level === 'string' ? req.query.level.toUpperCase() : '';
        const levelFilter = levelRaw === 'INFO' ||
            levelRaw === 'WARN' ||
            levelRaw === 'ERROR' ||
            levelRaw === 'DEBUG'
            ? levelRaw
            : null;
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
        let entries = lines
            .map(adminLogFormat_1.parseAdminLogLine)
            .filter((e) => e !== null);
        if (levelFilter) {
            entries = entries.filter((e) => e.level === levelFilter);
        }
        if (filter) {
            entries = entries.filter((e) => {
                const hay = `${e.message} ${e.raw}`.toLowerCase();
                return hay.includes(filter);
            });
        }
        const slice = entries.slice(-limit);
        const stats = {
            total: slice.length,
            info: slice.filter((e) => e.level === 'INFO').length,
            warn: slice.filter((e) => e.level === 'WARN').length,
            error: slice.filter((e) => e.level === 'ERROR').length,
            debug: slice.filter((e) => e.level === 'DEBUG').length,
        };
        res.json({
            entries: slice,
            stats,
            lines: slice.map((e) => e.raw),
        });
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
        const access = await (0, channelFullDisconnect_1.resolveRegisteredChannelAccess)(deps.bot, chatId);
        if (access === 'chat_unreachable') {
            await (0, channelFullDisconnect_1.fullyDisconnectRegisteredChannel)(deps.bot, chatId, 'registry_stale_removed');
            res.status(404).json({ error: 'channel not found' });
            return;
        }
        if (access === 'bot_not_in_chat') {
            await (0, channelFullDisconnect_1.fullyDisconnectRegisteredChannel)(deps.bot, chatId, 'removed_from_chat');
            res.status(404).json({ error: 'channel not found' });
            return;
        }
        const comments = commentStore_1.commentStore.listCommentsForChannelChatId(chatId, 8).map((c) => {
            const post = postStore_1.postStore.getPost(c.post_id);
            const answered = Boolean(c.reply?.text);
            return {
                comment_id: c.comment_id,
                post_id: c.post_id,
                username: c.username,
                text: c.text,
                timestamp: c.timestamp,
                ...(c.source === 'telegram' ? { source: 'telegram' } : {}),
                reply_status: answered ? 'answered' : 'unanswered',
                reply: answered
                    ? {
                        text: c.reply.text,
                        timestamp: c.reply.timestamp,
                        admin_name: c.reply.admin_name ?? null,
                    }
                    : null,
                post_context: post
                    ? {
                        text: post.text,
                        sender_name: post.sender_name ?? null,
                        photo_url: post.photo_url ?? null,
                        channel_post_url: post.channel_post_url ?? null,
                        timestamp: post.timestamp,
                    }
                    : null,
            };
        });
        const extras = await (0, adminPanelState_1.getChannelExtras)(chatId);
        const chains = (await (0, adminPanelState_1.listTgChains)()).filter((c) => c.max_chat_id === chatId);
        let subscribers = null;
        let avatar_url = null;
        try {
            const chat = await deps.bot.api.getChat(chatId);
            avatar_url = extractChatAvatarUrl(chat);
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
                status: access === 'ok' ? 'active' : 'pending',
                subscribers,
                post_count: postStore_1.postStore.countPostsByChatId(chatId),
                comment_count: commentStore_1.commentStore.countCommentsByChatId(chatId),
                date_added: ch.date_added,
                avatar_url,
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
            engine: data.engine,
            restricted_users: data.restricted_users,
            scored_words: data.scored_words,
            scored_words_total: data.scored_words_total,
            score_tiers: [...seedAntispamScoredWords_1.ANTISPAM_SCORE_TIERS],
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
        if (isRecord(req.body.engine)) {
            const eng = req.body.engine;
            const enginePatch = {};
            if (typeof eng.soft_mode === 'boolean')
                enginePatch.soft_mode = eng.soft_mode;
            if (typeof eng.enabled === 'boolean')
                enginePatch.enabled = eng.enabled;
            if (typeof eng.spam_threshold === 'number')
                enginePatch.spam_threshold = eng.spam_threshold;
            if (typeof eng.ban_threshold === 'number')
                enginePatch.ban_threshold = eng.ban_threshold;
            if (typeof eng.captcha_required_score === 'number') {
                enginePatch.captcha_required_score = eng.captcha_required_score;
            }
            if (typeof eng.emoji_overuse_limit === 'number') {
                enginePatch.emoji_overuse_limit = eng.emoji_overuse_limit;
            }
            if (Array.isArray(eng.whitelist_user_ids)) {
                enginePatch.whitelist_user_ids = eng.whitelist_user_ids.filter((id) => typeof id === 'number' && id > 0);
            }
            if (Array.isArray(eng.blacklist_user_ids)) {
                enginePatch.blacklist_user_ids = eng.blacklist_user_ids.filter((id) => typeof id === 'number' && id > 0);
            }
            if (Object.keys(enginePatch).length > 0) {
                await (0, adminPanelState_1.saveAntispamEngine)(enginePatch);
            }
        }
        res.json({ ok: true });
    });
    secured.post('/antispam/scored-words', async (req, res) => {
        if (!isRecord(req.body) || !isRecord(req.body.scored_words)) {
            res.status(400).json({ error: 'invalid scored_words' });
            return;
        }
        const raw = req.body.scored_words;
        const dict = {};
        for (const tier of seedAntispamScoredWords_1.ANTISPAM_SCORE_TIERS) {
            const arr = raw[String(tier)];
            dict[tier] = Array.isArray(arr)
                ? [
                    ...new Set(arr
                        .filter((w) => typeof w === 'string')
                        .map((w) => w.trim().toLowerCase())
                        .filter(Boolean)),
                ]
                : [];
        }
        const saved = await (0, adminPanelState_1.saveScoredWords)(dict);
        res.json({ ok: true, scored_words: saved, scored_words_total: Object.values(saved).flat().length });
    });
    secured.post('/antispam/scored-words/reset', async (_req, res) => {
        const saved = (0, seedAntispamScoredWords_1.resetScoredWordsToDefault)();
        res.json({
            ok: true,
            scored_words: saved,
            scored_words_total: Object.values(saved).flat().length,
        });
    });
    secured.post('/antispam/test', async (req, res) => {
        if (!isRecord(req.body)) {
            res.status(400).json({ error: 'invalid body' });
            return;
        }
        const text = typeof req.body.text === 'string' ? req.body.text : '';
        const chatIdRaw = req.body.chat_id;
        const chatId = typeof chatIdRaw === 'number' && Number.isInteger(chatIdRaw) && chatIdRaw !== 0
            ? chatIdRaw
            : 0;
        const { evaluateComment } = await Promise.resolve().then(() => __importStar(require('../services/antispamService')));
        const result = evaluateComment({
            text,
            userId: 0,
            username: 'test',
            channelChatId: chatId,
            source: 'max',
        });
        res.json({ ok: true, result });
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
        const mtproto = (0, mtprotoConfigStore_1.resolveMtprotoCredentials)();
        res.json({
            chains,
            stats: { active, forwarded_today: forwardedToday, errors_today: errorsToday },
            mtproto: {
                ready: (0, mtprotoConfigStore_1.isMtprotoSessionReady)(),
                source: mtproto.source,
            },
        });
    });
    secured.post('/tg-chains', async (req, res) => {
        if (!isRecord(req.body)) {
            res.status(400).json({ error: 'invalid body' });
            return;
        }
        const maxChatId = parseNonZeroInt(req.body.max_chat_id);
        const tgRaw = parseNonEmptyString(req.body.tg_channel) ?? parseNonEmptyString(req.body.tg_username);
        if (maxChatId === null || !tgRaw) {
            res.status(400).json({ error: 'max_chat_id and tg_channel required' });
            return;
        }
        const tgKey = tgRaw.trim();
        await integrationsStore_1.integrationsStore.load();
        const integ = integrationsStore_1.integrationsStore.getTelegramIntegration();
        const tgToken = (parseNonEmptyString(req.body.bot_token) ??
            integ?.token?.trim() ??
            (0, config_1.getTelegramToken)()).trim();
        if (!tgToken) {
            res.status(400).json({ error: 'Не задан токен Telegram-бота (интеграция или TG_TOKEN)' });
            return;
        }
        const resolved = await (0, tgChainChannelRef_1.resolveTgChainChannelFields)(tgToken, tgKey);
        if (!resolved?.tg_channel_id || !/^-100\d+$/.test(resolved.tg_channel_id)) {
            res.status(400).json({
                error: 'Не удалось определить Telegram-канал. Укажите @username или -100… id; бот должен быть админом канала.',
            });
            return;
        }
        const tgChannelId = resolved.tg_channel_id;
        const tgUsername = resolved.tg_username ||
            (tgKey.startsWith('@') ? tgKey.replace(/^@/, '') : '') ||
            parseNonEmptyString(req.body.tg_username)?.replace(/^@/, '') ||
            '';
        const existing = (0, tgChainPair_1.findActiveTgChainForPair)(await (0, adminPanelState_1.listTgChains)(), maxChatId, tgChannelId, tgUsername);
        if (existing) {
            res.status(400).json({ error: 'Активная цепочка для этой пары TG → MAX уже есть' });
            return;
        }
        const ch = channelRegistry_1.channelRegistry.getChannel(maxChatId);
        const discussionChatId = parseTgDiscussionChatId(req.body.tg_discussion_chat_id);
        const discussionSendAs = parseDiscussionSendAs(req.body.tg_discussion_send_as);
        const commentSyncKeywords = parseCommentSyncKeywords(req.body.comment_sync_keywords);
        const commentSyncMatchMode = parseCommentSyncMatchMode(req.body.comment_sync_match_mode);
        const row = await (0, adminPanelState_1.createTgChain)({
            max_chat_id: maxChatId,
            max_title: ch?.title ?? null,
            tg_username: tgUsername,
            tg_channel_id: tgChannelId,
            bot_token: parseNonEmptyString(req.body.bot_token)?.trim() || tgToken,
            forward_posts: req.body.forward_posts !== false,
            forward_comments: Boolean(req.body.forward_comments),
            tg_discussion_chat_id: discussionChatId === undefined ? null : discussionChatId,
            ...(discussionSendAs ? { tg_discussion_send_as: discussionSendAs } : {}),
            comment_sync_keywords: (0, commentSyncFilter_1.normalizeCommentSyncKeywords)(commentSyncKeywords ?? []),
            ...(commentSyncMatchMode ? { comment_sync_match_mode: commentSyncMatchMode } : {}),
            add_comments_button: req.body.add_comments_button !== false,
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
        const discussionChatId = parseTgDiscussionChatId(req.body.tg_discussion_chat_id);
        if (discussionChatId !== undefined)
            patch.tg_discussion_chat_id = discussionChatId;
        const discussionSendAs = parseDiscussionSendAs(req.body.tg_discussion_send_as);
        if (discussionSendAs !== undefined)
            patch.tg_discussion_send_as = discussionSendAs;
        const commentSyncKeywords = parseCommentSyncKeywords(req.body.comment_sync_keywords);
        if ('comment_sync_keywords' in req.body) {
            patch.comment_sync_keywords = (0, commentSyncFilter_1.normalizeCommentSyncKeywords)(commentSyncKeywords ?? []);
        }
        const commentSyncMatchMode = parseCommentSyncMatchMode(req.body.comment_sync_match_mode);
        if ('comment_sync_match_mode' in req.body) {
            patch.comment_sync_match_mode = commentSyncMatchMode ?? 'contains';
        }
        if (typeof req.body.add_comments_button === 'boolean') {
            patch.add_comments_button = req.body.add_comments_button;
        }
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
    // ── VK-chains ──────────────────────────────────────────────────────────────
    secured.get('/vk-chains', async (_req, res) => {
        const chains = await (0, adminPanelState_1.listVkChains)();
        const active = chains.filter((c) => c.active).length;
        const forwardedToday = chains.reduce((s, c) => s + c.forwarded_today, 0);
        const errorsToday = chains.reduce((s, c) => s + c.errors_today, 0);
        res.json({
            chains,
            stats: { active, forwarded_today: forwardedToday, errors_today: errorsToday },
        });
    });
    /** Список сообществ VK, где токен имеет права модератора/редактора/администратора. */
    secured.get('/vk-groups', async (req, res) => {
        await integrationsStore_1.integrationsStore.load();
        const vkInt = integrationsStore_1.integrationsStore.getIntegrations().find((i) => i.platform === 'vk' && i.status === 'connected');
        const token = parseNonEmptyString(String(req.query.token ?? '')) ?? vkInt?.token ?? '';
        if (!token) {
            res.status(400).json({ error: 'VK не подключён — укажите токен' });
            return;
        }
        const groups = await (0, integrationPlatformClient_1.listVkManagedGroups)(token);
        res.json({ groups });
    });
    /** Разрешить VK-сообщество по URL, slug или числовому ID. */
    secured.post('/vk-resolve-group', async (req, res) => {
        if (!isRecord(req.body)) {
            res.status(400).json({ error: 'invalid body' });
            return;
        }
        await integrationsStore_1.integrationsStore.load();
        const vkInt = integrationsStore_1.integrationsStore.getIntegrations().find((i) => i.platform === 'vk' && i.status === 'connected');
        const token = parseNonEmptyString(req.body.vk_token) ?? vkInt?.token ?? '';
        const input = parseNonEmptyString(req.body.input);
        if (!token || !input) {
            res.status(400).json({ error: 'token and input required' });
            return;
        }
        const result = await (0, integrationPlatformClient_1.resolveVkGroup)(token, input);
        if (!result.group) {
            res.status(404).json({ error: result.error ?? 'Сообщество не найдено. Проверьте ссылку или ID.' });
            return;
        }
        res.json({ group: result.group });
    });
    secured.post('/vk-chains', async (req, res) => {
        if (!isRecord(req.body)) {
            res.status(400).json({ error: 'invalid body' });
            return;
        }
        const maxChatId = parseNonZeroInt(req.body.max_chat_id);
        const vkGroupIdRaw = parseNonEmptyString(req.body.vk_group_id);
        if (maxChatId === null || !vkGroupIdRaw) {
            res.status(400).json({ error: 'max_chat_id and vk_group_id required' });
            return;
        }
        await integrationsStore_1.integrationsStore.load();
        const vkInt = integrationsStore_1.integrationsStore.getIntegrations().find((i) => i.platform === 'vk' && i.status === 'connected');
        const vkToken = parseNonEmptyString(req.body.vk_token) ?? vkInt?.token ?? '';
        if (!vkToken) {
            res.status(400).json({ error: 'Токен VK не найден: укажите vk_token или подключите VK в Интеграциях' });
            return;
        }
        const vkGroupId = vkGroupIdRaw.replace(/^-/, '');
        // Резолвим сообщество, чтобы сохранить имя и screen_name
        let vkScreenName;
        let vkName;
        try {
            const info = await (0, integrationPlatformClient_1.resolveVkGroup)(vkToken, vkGroupId);
            if (info.group) {
                vkScreenName = info.group.screenName;
                vkName = info.group.name;
            }
        }
        catch {
            // не блокируем создание, если API недоступен
        }
        const existing = (await (0, adminPanelState_1.listVkChains)()).find((c) => c.active &&
            Math.abs(c.max_chat_id) === Math.abs(maxChatId) &&
            c.vk_group_id.replace(/^-/, '') === vkGroupId);
        if (existing) {
            res.status(400).json({ error: 'Активная VK-связка для этой пары MAX ↔ VK уже есть' });
            return;
        }
        const ch = channelRegistry_1.channelRegistry.getChannel(maxChatId);
        const row = await (0, adminPanelState_1.createVkChain)({
            max_chat_id: maxChatId,
            max_title: ch?.title ?? null,
            vk_group_id: vkGroupId,
            vk_screen_name: vkScreenName,
            vk_name: vkName,
            vk_token: vkToken,
            forward_posts: req.body.forward_posts !== false,
            sync_comments: Boolean(req.body.sync_comments),
            active: true,
        });
        res.json({ ok: true, chain: row });
    });
    secured.patch('/vk-chains/:id', async (req, res) => {
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
        if (typeof req.body.sync_comments === 'boolean')
            patch.sync_comments = req.body.sync_comments;
        const vkToken = parseNonEmptyString(req.body.vk_token);
        if (vkToken)
            patch.vk_token = vkToken;
        const vkGroupId = parseNonEmptyString(req.body.vk_group_id);
        if (vkGroupId)
            patch.vk_group_id = vkGroupId.replace(/^-/, '');
        const updated = await (0, adminPanelState_1.updateVkChain)(id, patch);
        if (!updated) {
            res.status(404).json({ error: 'not found' });
            return;
        }
        res.json({ ok: true, chain: updated });
    });
    secured.delete('/vk-chains/:id', async (req, res) => {
        const id = parseNonEmptyString(req.params.id);
        if (!id) {
            res.status(400).json({ error: 'invalid id' });
            return;
        }
        const ok = await (0, adminPanelState_1.deleteVkChain)(id);
        if (!ok) {
            res.status(404).json({ error: 'not found' });
            return;
        }
        res.json({ ok: true });
    });
    secured.use('/autoposts', (0, autopostRoutes_1.createAutopostRouter)());
    secured.post('/refresh-buttons', async (req, res) => {
        const body = req.body;
        const chatId = isRecord(body) ? parseNonZeroInt(body.chat_id) : null;
        if (chatId === null) {
            res.status(400).json({ error: 'invalid chat_id' });
            return;
        }
        try {
            const firstPass = await (0, channelPoller_1.runChannelPollerForChat)(deps.bot, chatId, {
                // Admin click should return quickly; deep 24h sweep is handled by scheduled poller and retries.
                lookbackMs: 6 * 60 * 60 * 1000,
                maxPages: 8,
            });
            const diagnosis = await (0, postLinkDiagnostics_1.diagnosePostLinks)(chatId);
            const mids = [...new Set(diagnosis.candidates
                    .map((c) => c.message_mid?.trim())
                    .filter((v) => Boolean(v)))].slice(0, 20);
            let restoredFromLogs = 0;
            for (const mid of mids) {
                const recovered = await (0, channelPostActions_1.ensurePostFromChannelMessage)(deps.bot, chatId, mid);
                if (recovered) {
                    restoredFromLogs += 1;
                }
            }
            res.json({
                ok: true,
                ...firstPass,
                restored_from_logs: restoredFromLogs,
                diagnostics: {
                    signals_total: diagnosis.signals_total,
                    id_mismatch: diagnosis.id_mismatch,
                    post_lookup_not_found: diagnosis.post_lookup_not_found,
                    candidates: diagnosis.candidates.slice(0, 20),
                },
            });
        }
        catch (err) {
            if (err instanceof channelPoller_1.RefreshButtonsError) {
                const status = err.code === 'miniapp_not_configured'
                    ? 503
                    : err.code === 'channel_not_found'
                        ? 404
                        : 502;
                res.status(status).json({ error: err.message, code: err.code });
                return;
            }
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
    secured.post('/users/restrict', (req, res) => {
        const body = req.body;
        const userId = isRecord(body) ? parsePositiveInt(body.user_id) : null;
        const restricted = isRecord(body) ? parseBoolean(body.restricted) : null;
        if (!userId || restricted === null) {
            res.status(400).json({ error: 'invalid user_id or restricted flag' });
            return;
        }
        if (userId === config_1.config.ownerUserId) {
            res.status(400).json({ error: 'cannot restrict owner' });
            return;
        }
        if (restricted) {
            disabledAdminStore_1.disabledAdminStore.disableUser(userId);
        }
        else {
            disabledAdminStore_1.disabledAdminStore.enableUser(userId);
        }
        res.json({ ok: true, user_id: userId, restricted });
    });
    secured.post('/users/notify', async (req, res) => {
        const body = req.body;
        const userId = isRecord(body) ? parsePositiveInt(body.user_id) : null;
        const text = isRecord(body) ? parseNonEmptyString(body.text) : null;
        if (!userId || !text) {
            res.status(400).json({ error: 'invalid user_id or text' });
            return;
        }
        if (text.length > 2000) {
            res.status(400).json({ error: 'text is too long' });
            return;
        }
        try {
            await deps.bot.api.sendMessageToUser(userId, text);
            res.json({ ok: true });
        }
        catch (err) {
            logger_1.logger.warn('admin /users/notify failed', { userId, err });
            res.status(502).json({ error: 'не удалось отправить уведомление пользователю' });
        }
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