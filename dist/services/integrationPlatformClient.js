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
exports.ensureTelegramPollingMode = ensureTelegramPollingMode;
exports.listTelegramChannelsFromRegistry = listTelegramChannelsFromRegistry;
exports.telegramLinkedChatsSnapshotChanged = telegramLinkedChatsSnapshotChanged;
exports.buildTelegramLinkedChatsList = buildTelegramLinkedChatsList;
exports.mergePlatformChannels = mergePlatformChannels;
exports.getTelegramBotUserId = getTelegramBotUserId;
exports.enrichTelegramChatsWithBotAdmin = enrichTelegramChatsWithBotAdmin;
exports.validateTelegramToken = validateTelegramToken;
exports.validateVkToken = validateVkToken;
exports.testIntegration = testIntegration;
exports.resolveTelegramChannelChatIdFromKey = resolveTelegramChannelChatIdFromKey;
exports.listTelegramBotChats = listTelegramBotChats;
exports.listTelegramAdminChannels = listTelegramAdminChannels;
exports.listTelegramChatAdministrators = listTelegramChatAdministrators;
exports.listVkGroups = listVkGroups;
exports.resolveVkGroup = resolveVkGroup;
exports.listVkManagedGroups = listVkManagedGroups;
exports.fetchTelegramChannelPosts = fetchTelegramChannelPosts;
exports.fetchVkWallPosts = fetchVkWallPosts;
exports.publishVkWallPost = publishVkWallPost;
exports.fetchVkWallComments = fetchVkWallComments;
exports.publishVkWallComment = publishVkWallComment;
const axios_1 = __importDefault(require("axios"));
const adminPanelState_1 = require("../api/adminPanelState");
const logger_1 = require("../utils/logger");
const telegramBotUserStore_1 = require("./telegramBotUserStore");
const telegramMainBotUpdates_1 = require("./telegramMainBotUpdates");
const resolveTelegramBotToken_1 = require("./resolveTelegramBotToken");
const flowStateStore_1 = require("./flowStateStore");
const telegramMainBotOffsetStore_1 = require("./telegramMainBotOffsetStore");
const tgChannelMatch_1 = require("../utils/tgChannelMatch");
const telegramChannelRegistry_1 = require("./telegramChannelRegistry");
const TG_API = 'https://api.telegram.org';
const TELEGRAM_DISCOVERY_UPDATES = [
    'message',
    'edited_message',
    'channel_post',
    'edited_channel_post',
    'my_chat_member',
];
const TELEGRAM_DISCOVERY_MAX_PAGES = 16;
function isNumericTelegramChatId(raw) {
    return /^-?\d+$/.test(String(raw).trim());
}
function persistTelegramChannelsToRegistry(channels) {
    for (const ch of channels) {
        if (ch.type !== 'channel' && ch.type !== 'supergroup' && ch.type !== 'group') {
            continue;
        }
        telegramChannelRegistry_1.telegramChannelRegistry.saveChannel({
            chatId: ch.id,
            title: ch.title,
            username: ch.username,
            type: ch.type ?? 'channel',
            botIsAdmin: ch.botIsAdmin === true,
        });
    }
}
/** ID из реестра, кэша интеграции и TG→MAX связок — для проверки прав бота через getChatMember. */
async function buildTelegramLinkedChatCandidateStubs(token, options) {
    await (0, adminPanelState_1.ensureAdminPanelStateLoaded)();
    const ids = new Set();
    for (const row of telegramChannelRegistry_1.telegramChannelRegistry.getAllChannels()) {
        ids.add(row.chat_id);
    }
    for (const ch of options.existingLinkedChats ?? []) {
        const id = String(ch.id ?? '').trim();
        if (isNumericTelegramChatId(id)) {
            ids.add(id);
        }
    }
    for (const chain of (0, adminPanelState_1.listTgChainsSync)()) {
        const channelId = chain.tg_channel_id?.trim() ?? '';
        if (isNumericTelegramChatId(channelId)) {
            ids.add(channelId);
        }
        const discussionId = chain.tg_discussion_chat_id?.trim() ?? '';
        if (isNumericTelegramChatId(discussionId)) {
            ids.add(discussionId);
        }
        if (options.resolveUsernames) {
            const uname = chain.tg_username?.trim().replace(/^@/, '') ?? '';
            if (uname && !isNumericTelegramChatId(channelId)) {
                const resolved = await resolveTelegramChannelChatIdFromKey(token, `@${uname}`);
                if (resolved && isNumericTelegramChatId(resolved.chatId)) {
                    ids.add(resolved.chatId);
                }
            }
        }
    }
    return [...ids].map((id) => {
        const reg = telegramChannelRegistry_1.telegramChannelRegistry.getChannel(id);
        const rawType = reg?.type?.trim() ?? 'channel';
        const type = rawType === 'channel' ||
            rawType === 'supergroup' ||
            rawType === 'group' ||
            rawType === 'private'
            ? rawType
            : 'channel';
        const username = reg?.username && reg.username.trim() !== ''
            ? reg.username.startsWith('@')
                ? reg.username
                : `@${reg.username.replace(/^@/, '')}`
            : undefined;
        return {
            id,
            title: reg?.title?.trim() || id,
            username,
            type,
            botIsAdmin: reg?.bot_is_admin,
        };
    });
}
async function finalizeTelegramLinkedChatsList(options) {
    const trimmed = options.token.trim();
    const registryChannels = listTelegramChannelsFromRegistry();
    const candidateStubs = await buildTelegramLinkedChatCandidateStubs(trimmed, {
        existingLinkedChats: options.existingLinkedChats,
        resolveUsernames: options.refresh,
    });
    let channels = mergePlatformChannels(mergePlatformChannels(options.existingLinkedChats, options.discovered), mergePlatformChannels(registryChannels, candidateStubs));
    if (trimmed !== '') {
        channels = await enrichTelegramChatsWithBotAdmin(trimmed, channels);
        if (options.refresh) {
            persistTelegramChannelsToRegistry(channels);
        }
    }
    return channels;
}
/** Webhook блокирует getUpdates — для опроса и обнаружения чатов нужен polling. */
async function ensureTelegramPollingMode(token) {
    try {
        const { data } = await axios_1.default.get(`${TG_API}/bot${token}/getWebhookInfo`, { timeout: 10_000 });
        const url = data.result?.url?.trim();
        if (!data.ok || !url) {
            return;
        }
        await axios_1.default.get(`${TG_API}/bot${token}/deleteWebhook`, {
            params: { drop_pending_updates: false },
            timeout: 15_000,
        });
        logger_1.logger.info('ensureTelegramPollingMode: webhook снят для getUpdates', { hadUrl: url });
    }
    catch (err) {
        logger_1.logger.warn('ensureTelegramPollingMode failed', err);
    }
}
/** Каналы из SQLite (my_chat_member / активация), которые могут отсутствовать в getUpdates. */
function listTelegramChannelsFromRegistry() {
    return telegramChannelRegistry_1.telegramChannelRegistry.getAllChannels().map((row) => {
        const rawType = row.type?.trim() ?? 'channel';
        const type = rawType === 'channel' ||
            rawType === 'supergroup' ||
            rawType === 'group' ||
            rawType === 'private'
            ? rawType
            : 'channel';
        const username = row.username && row.username.trim() !== ''
            ? row.username.startsWith('@')
                ? row.username
                : `@${row.username.replace(/^@/, '')}`
            : undefined;
        return {
            id: row.chat_id,
            title: row.title?.trim() || row.chat_id,
            username,
            type,
            botIsAdmin: row.bot_is_admin,
        };
    });
}
function telegramLinkedChatsSnapshotChanged(before, after) {
    const prev = before ?? [];
    if (prev.length !== after.length) {
        return true;
    }
    const nextById = new Map(after.map((c) => [c.id, c]));
    for (const ch of prev) {
        const n = nextById.get(ch.id);
        if (!n) {
            return true;
        }
        if ((ch.botIsAdmin === true) !== (n.botIsAdmin === true)) {
            return true;
        }
        if (ch.title !== n.title || ch.username !== n.username) {
            return true;
        }
    }
    return false;
}
async function syncTelegramDiscoveryBeforeList(token) {
    if (!(0, resolveTelegramBotToken_1.isMainTelegramBotToken)(token)) {
        return;
    }
    try {
        const { syncMainTelegramBotDiscoveryUpdates } = await Promise.resolve().then(() => __importStar(require('./tgChainForwarder')));
        await syncMainTelegramBotDiscoveryUpdates(token, {
            timeoutSec: 0,
            maxPages: TELEGRAM_DISCOVERY_MAX_PAGES,
        });
    }
    catch (err) {
        logger_1.logger.warn('syncTelegramDiscoveryBeforeList failed', err);
    }
}
/** Список чатов для интеграции: кэш, getUpdates и реестр tg_channels. */
async function buildTelegramLinkedChatsList(options) {
    const { integrationId, token, existingLinkedChats, refresh } = options;
    const trimmed = token.trim();
    if (!refresh && (existingLinkedChats?.length ?? 0) > 0) {
        return finalizeTelegramLinkedChatsList({
            token: trimmed,
            existingLinkedChats,
            discovered: [],
            refresh: false,
        });
    }
    if (refresh && trimmed !== '') {
        await syncTelegramDiscoveryBeforeList(trimmed);
    }
    const discovered = trimmed !== '' ? await listTelegramBotChats(trimmed, integrationId) : [];
    return finalizeTelegramLinkedChatsList({
        token: trimmed,
        existingLinkedChats,
        discovered,
        refresh,
    });
}
function mergePlatformChannels(existing, discovered) {
    const seen = new Map();
    for (const ch of existing ?? []) {
        seen.set(ch.id, { ...ch });
    }
    for (const ch of discovered) {
        const prev = seen.get(ch.id);
        if (!prev) {
            seen.set(ch.id, ch);
            continue;
        }
        seen.set(ch.id, {
            id: ch.id,
            title: ch.title.length > prev.title.length ? ch.title : prev.title,
            username: ch.username ?? prev.username,
            type: ch.type && ch.type !== 'unknown' ? ch.type : prev.type,
            botIsAdmin: prev.botIsAdmin === true || ch.botIsAdmin === true,
        });
    }
    const typeOrder = {
        channel: 0,
        supergroup: 1,
        group: 2,
        private: 3,
        unknown: 4,
    };
    return [...seen.values()].sort((a, b) => {
        const adminDiff = Number(b.botIsAdmin === true) - Number(a.botIsAdmin === true);
        if (adminDiff !== 0)
            return adminDiff;
        const typeDiff = (typeOrder[a.type ?? 'unknown'] ?? 9) - (typeOrder[b.type ?? 'unknown'] ?? 9);
        if (typeDiff !== 0)
            return typeDiff;
        return a.title.localeCompare(b.title, 'ru');
    });
}
async function getTelegramBotUserId(token) {
    try {
        const { data } = await axios_1.default.get(`${TG_API}/bot${token}/getMe`, { timeout: 15_000 });
        const id = data.result?.id;
        return typeof id === 'number' ? id : null;
    }
    catch {
        return null;
    }
}
async function fetchTelegramChatMemberStatus(token, chatId, botUserId) {
    try {
        const { data } = await axios_1.default.get(`${TG_API}/bot${token}/getChatMember`, {
            params: { chat_id: chatId, user_id: botUserId },
            timeout: 12_000,
        });
        const status = data.result?.status ?? '';
        const botIsAdmin = status === 'administrator' || status === 'creator';
        if (!data.ok) {
            logger_1.logger.debug('fetchTelegramChatMemberStatus: getChatMember not ok', { chatId });
            return { botIsAdmin: false };
        }
        let chatMeta = { ok: false };
        try {
            const { data: chatData } = await axios_1.default.get(`${TG_API}/bot${token}/getChat`, {
                params: { chat_id: chatId },
                timeout: 12_000,
            });
            chatMeta = chatData;
        }
        catch {
            chatMeta = { ok: false };
        }
        const chat = chatMeta.ok ? chatMeta.result : undefined;
        return {
            botIsAdmin,
            title: chat ? chatTitleFromTelegramChat(chat, chatId) : undefined,
            username: typeof chat?.username === 'string' && chat.username.trim() !== ''
                ? `@${chat.username.replace(/^@/, '')}`
                : undefined,
            type: chat ? normalizeTelegramChatType(chat.type) : undefined,
        };
    }
    catch (err) {
        logger_1.logger.debug('fetchTelegramChatMemberStatus failed', { chatId, err });
        return { botIsAdmin: false };
    }
}
/** Проверяет через getChatMember/getChat, где бот администратор (в т.ч. уже сохранённые чаты). */
async function enrichTelegramChatsWithBotAdmin(token, chats) {
    const trimmed = token.trim();
    if (trimmed === '' || chats.length === 0) {
        return chats;
    }
    const botUserId = await getTelegramBotUserId(trimmed);
    if (botUserId === null) {
        return chats;
    }
    const enriched = [];
    for (const ch of chats) {
        const member = await fetchTelegramChatMemberStatus(trimmed, ch.id, botUserId);
        enriched.push({
            id: ch.id,
            title: member.title && member.title.length > ch.title.length ? member.title : ch.title,
            username: member.username ?? ch.username,
            type: member.type && member.type !== 'unknown' ? member.type : ch.type,
            botIsAdmin: ch.botIsAdmin === true || member.botIsAdmin,
        });
    }
    return mergePlatformChannels(undefined, enriched);
}
async function validateTelegramToken(token) {
    try {
        const { data } = await axios_1.default.get(`${TG_API}/bot${token}/getMe`, { timeout: 15_000 });
        if (!data.ok || !data.result) {
            return { ok: false, error: 'Telegram API вернул ошибку' };
        }
        const name = data.result.username ? `@${data.result.username}` : data.result.first_name ?? 'bot';
        return { ok: true, info: name };
    }
    catch (err) {
        logger_1.logger.debug('validateTelegramToken failed', err);
        return { ok: false, error: 'Не удалось проверить токен Telegram' };
    }
}
async function validateVkToken(token, groupId) {
    try {
        const params = {
            access_token: token,
            v: '5.199',
        };
        if (groupId && groupId.trim() !== '') {
            params.group_id = groupId.replace(/^-/, '').replace(/^public/, '');
        }
        const { data } = await axios_1.default.get('https://api.vk.com/method/groups.getById', { params, timeout: 15_000 });
        if (data.error) {
            return { ok: false, error: data.error.error_msg ?? 'VK API error' };
        }
        const g = data.response?.[0];
        if (!g && groupId) {
            const userCheck = await axios_1.default.get('https://api.vk.com/method/users.get', {
                params: { access_token: token, v: '5.199' },
                timeout: 15_000,
            });
            if (userCheck.data.error) {
                return { ok: false, error: userCheck.data.error.error_msg ?? 'VK token invalid' };
            }
            const u = userCheck.data.response?.[0];
            return {
                ok: true,
                info: u ? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() : 'VK token OK',
            };
        }
        return {
            ok: true,
            info: g ? g.name ?? g.screen_name ?? 'VK сообщество' : 'VK token OK',
        };
    }
    catch (err) {
        logger_1.logger.debug('validateVkToken failed', err);
        return { ok: false, error: 'Не удалось проверить токен VK' };
    }
}
async function testIntegration(platform, token, groupId) {
    if (platform === 'telegram')
        return validateTelegramToken(token);
    return validateVkToken(token, groupId);
}
function normalizeTelegramChatType(raw) {
    if (raw === 'channel' || raw === 'group' || raw === 'supergroup' || raw === 'private') {
        return raw;
    }
    return 'unknown';
}
function chatTitleFromTelegramChat(chat, fallbackId) {
    if (typeof chat.title === 'string' && chat.title.trim() !== '') {
        return chat.title.trim();
    }
    const first = typeof chat.first_name === 'string' ? chat.first_name : '';
    const last = typeof chat.last_name === 'string' ? chat.last_name : '';
    const combined = `${first} ${last}`.trim();
    return combined !== '' ? combined : fallbackId;
}
function mergeTelegramChat(seen, chat, botIsAdmin) {
    if (typeof chat.id !== 'number' && typeof chat.id !== 'string') {
        return;
    }
    const id = String(chat.id);
    const type = normalizeTelegramChatType(chat.type);
    const username = typeof chat.username === 'string' && chat.username.trim() !== ''
        ? chat.username.startsWith('@')
            ? chat.username
            : `@${chat.username}`
        : undefined;
    const title = chatTitleFromTelegramChat(chat, id);
    const existing = seen.get(id);
    if (!existing) {
        seen.set(id, { id, title, username, type, botIsAdmin });
        return;
    }
    seen.set(id, {
        id,
        title: title.length > existing.title.length ? title : existing.title,
        username: username ?? existing.username,
        type: type !== 'unknown' ? type : existing.type,
        botIsAdmin: existing.botIsAdmin === true || botIsAdmin,
    });
}
function ingestTelegramUpdate(seen, upd) {
    const mcm = upd.my_chat_member;
    if (mcm) {
        const chat = mcm.chat;
        const member = mcm.new_chat_member;
        const status = typeof member?.status === 'string' ? member.status : '';
        const isAdmin = status === 'administrator' || status === 'creator';
        const isMember = isAdmin || status === 'member';
        if (chat && isMember) {
            mergeTelegramChat(seen, chat, isAdmin);
        }
    }
    for (const key of ['channel_post', 'edited_channel_post', 'message', 'edited_message']) {
        const msg = upd[key];
        const chat = msg?.chat;
        if (chat) {
            mergeTelegramChat(seen, chat, false);
        }
    }
}
function parseTelegramUserFromUnknown(raw) {
    if (typeof raw !== 'object' || raw === null) {
        return null;
    }
    const o = raw;
    const id = typeof o.id === 'number' ? o.id : Number.NaN;
    if (!Number.isInteger(id) || id <= 0) {
        return null;
    }
    return {
        id,
        username: typeof o.username === 'string' ? o.username : undefined,
        first_name: typeof o.first_name === 'string' ? o.first_name : undefined,
        last_name: typeof o.last_name === 'string' ? o.last_name : undefined,
    };
}
function rememberTelegramStartedUserFromUpdate(upd) {
    const message = upd.message;
    if (message) {
        const chat = message.chat;
        const chatType = typeof chat?.type === 'string' ? chat.type : '';
        const fromUser = parseTelegramUserFromUnknown(message.from);
        if (chatType === 'private' && fromUser) {
            telegramBotUserStore_1.telegramBotUserStore.markStarted(fromUser);
        }
    }
    const callback = upd.callback_query;
    if (callback) {
        const fromUser = parseTelegramUserFromUnknown(callback.from);
        if (fromUser) {
            telegramBotUserStore_1.telegramBotUserStore.markStarted(fromUser);
        }
    }
}
/** Разрешает @username / t.me/… / -100… в числовой chat_id через getChat. */
async function resolveTelegramChannelChatIdFromKey(token, channelKeyRaw) {
    const trimmed = channelKeyRaw.trim();
    if (!trimmed) {
        return null;
    }
    let lookup = trimmed;
    const tmeMatch = /(?:https?:\/\/)?t\.me\/([a-zA-Z0-9_]+)/i.exec(trimmed);
    if (tmeMatch) {
        lookup = `@${tmeMatch[1]}`;
    }
    else if (/^t\.me\//i.test(trimmed)) {
        lookup = `@${trimmed.replace(/^t\.me\//i, '')}`;
    }
    else if (!lookup.startsWith('@') && !/^-?\d+$/.test(lookup)) {
        lookup = `@${lookup.replace(/^@/, '')}`;
    }
    const tgToken = token.trim();
    if (!tgToken) {
        return null;
    }
    try {
        const { data } = await axios_1.default.get(`${TG_API}/bot${tgToken}/getChat`, {
            params: { chat_id: /^-?\d+$/.test(lookup) ? lookup : (0, tgChannelMatch_1.normalizeTelegramChannelKey)(lookup) },
            timeout: 15_000,
        });
        if (!data.ok || !data.result) {
            return null;
        }
        const chat = data.result;
        const id = typeof chat.id === 'number' || typeof chat.id === 'string' ? String(chat.id) : null;
        if (!id || !/^-?\d+$/.test(id)) {
            return null;
        }
        const chatType = normalizeTelegramChatType(chat.type);
        const username = typeof chat.username === 'string' && chat.username.trim() !== ''
            ? `@${chat.username.replace(/^@/, '')}`
            : null;
        return {
            chatId: id,
            title: chatTitleFromTelegramChat(chat, id),
            username,
            type: chatType,
        };
    }
    catch (err) {
        logger_1.logger.warn('resolveTelegramChannelChatIdFromKey: getChat failed', { lookup, err });
        return null;
    }
}
/** Чаты/каналы, с которыми бот взаимодействовал (из getUpdates + my_chat_member). */
async function listTelegramBotChats(token, integrationId) {
    const trimmed = token.trim();
    if (trimmed === '') {
        return [];
    }
    await ensureTelegramPollingMode(trimmed);
    const seen = new Map();
    await flowStateStore_1.flowStateStore.load();
    const useMainBotOffset = (0, resolveTelegramBotToken_1.isMainTelegramBotToken)(trimmed);
    let offset = useMainBotOffset
        ? (0, telegramMainBotOffsetStore_1.getTelegramBotUpdatesOffset)(trimmed)
        : integrationId !== undefined
            ? flowStateStore_1.flowStateStore.getTelegramUpdateOffset(integrationId)
            : undefined;
    try {
        for (let page = 0; page < TELEGRAM_DISCOVERY_MAX_PAGES; page++) {
            const params = {
                limit: 100,
                timeout: 0,
                allowed_updates: JSON.stringify(TELEGRAM_DISCOVERY_UPDATES),
            };
            if (offset !== undefined) {
                params.offset = offset;
            }
            const { data } = await axios_1.default.get(`${TG_API}/bot${trimmed}/getUpdates`, { params, timeout: 20_000 });
            if (!data.ok || !data.result?.length) {
                break;
            }
            for (const upd of data.result) {
                const updateId = typeof upd.update_id === 'number' ? upd.update_id : 0;
                if (updateId >= (offset ?? 0)) {
                    offset = updateId + 1;
                }
                rememberTelegramStartedUserFromUpdate(upd);
                await (0, telegramMainBotUpdates_1.processMainTelegramBotMyChatMemberUpdate)(trimmed, upd);
                ingestTelegramUpdate(seen, upd);
            }
            if (data.result.length < 100) {
                break;
            }
        }
        if (offset !== undefined) {
            if (useMainBotOffset) {
                (0, telegramMainBotOffsetStore_1.setTelegramBotUpdatesOffset)(trimmed, offset);
            }
            else if (integrationId !== undefined) {
                await flowStateStore_1.flowStateStore.setTelegramUpdateOffset(integrationId, offset);
            }
        }
    }
    catch (err) {
        logger_1.logger.warn('listTelegramBotChats: getUpdates failed', err);
    }
    const discovered = [...seen.values()];
    if (discovered.length === 0) {
        return [];
    }
    return enrichTelegramChatsWithBotAdmin(trimmed, discovered);
}
async function listTelegramAdminChannels(token) {
    return listTelegramBotChats(token);
}
async function listTelegramChatAdministrators(token, chatId) {
    const trimmed = token.trim();
    if (trimmed === '') {
        return [];
    }
    try {
        const { data } = await axios_1.default.get(`${TG_API}/bot${trimmed}/getChatAdministrators`, {
            params: { chat_id: chatId },
            timeout: 15_000,
        });
        if (!data.ok || !Array.isArray(data.result)) {
            return [];
        }
        const rows = [];
        for (const row of data.result) {
            const user = row.user;
            const userId = typeof user?.id === 'number' ? user.id : null;
            if (userId === null || !Number.isInteger(userId) || userId <= 0) {
                continue;
            }
            const first = typeof user?.first_name === 'string' ? user.first_name.trim() : '';
            const last = typeof user?.last_name === 'string' ? user.last_name.trim() : '';
            const fullName = `${first} ${last}`.trim();
            const username = typeof user?.username === 'string' ? user.username.trim() : '';
            rows.push({
                userId,
                name: fullName || username || String(userId),
                username: username ? `@${username.replace(/^@/, '')}` : undefined,
                isCreator: row.status === 'creator',
            });
        }
        const started = telegramBotUserStore_1.telegramBotUserStore.getStartedIds(rows.map((r) => r.userId));
        return rows
            .map((row) => ({
            ...row,
            startedBot: started.has(row.userId),
        }))
            .sort((a, b) => {
            const creatorDiff = Number(b.isCreator) - Number(a.isCreator);
            if (creatorDiff !== 0)
                return creatorDiff;
            const startedDiff = Number(b.startedBot) - Number(a.startedBot);
            if (startedDiff !== 0)
                return startedDiff;
            return a.name.localeCompare(b.name, 'ru');
        });
    }
    catch {
        return [];
    }
}
async function listVkGroups(token, groupId) {
    if (!groupId || groupId.trim() === '') {
        return [];
    }
    try {
        const { data } = await axios_1.default.get('https://api.vk.com/method/groups.getById', {
            params: {
                access_token: token,
                group_id: groupId.replace(/^-/, '').replace(/^public/, ''),
                v: '5.199',
            },
            timeout: 15_000,
        });
        if (data.error || !data.response?.length)
            return [];
        return data.response.map((g) => ({
            id: String(-g.id),
            title: g.name ?? String(g.id),
            username: g.screen_name ? g.screen_name : undefined,
        }));
    }
    catch (err) {
        logger_1.logger.debug('listVkGroups failed', err);
        return [];
    }
}
/**
 * Разрешает VK-сообщество из любого формата ввода:
 * числовой ID, -ID, URL (vk.com/...), slug (ostrovskidok).
 */
async function resolveVkGroup(token, input) {
    const raw = input.trim();
    if (!raw)
        return null;
    // Извлекаем slug/id из URL: vk.com/club123, vk.com/public123, vk.com/slug
    const urlMatch = /(?:https?:\/\/)?(?:www\.)?vk\.com\/([a-zA-Z0-9_.-]+)/i.exec(raw);
    let lookup = urlMatch ? urlMatch[1] : raw;
    // Убираем минус в начале, чтобы VK API принял ID без знака
    lookup = lookup.replace(/^-/, '');
    try {
        const { data } = await axios_1.default.get('https://api.vk.com/method/groups.getById', {
            params: {
                access_token: token,
                group_id: lookup,
                fields: 'screen_name,photo_50,photo_100',
                v: '5.199',
            },
            timeout: 15_000,
        });
        if (data.error || !data.response?.length) {
            return null;
        }
        const g = data.response[0];
        const screenName = g.screen_name ?? `club${g.id}`;
        return {
            id: String(g.id),
            name: g.name?.trim() || `club${g.id}`,
            screenName,
            url: `https://vk.com/${screenName}`,
            photo: g.photo_100 ?? g.photo_50,
        };
    }
    catch (err) {
        logger_1.logger.debug('resolveVkGroup failed', { input, err });
        return null;
    }
}
/**
 * Список сообществ, где токен имеет права администратора/редактора.
 */
async function listVkManagedGroups(token) {
    try {
        const { data } = await axios_1.default.get('https://api.vk.com/method/groups.get', {
            params: {
                access_token: token,
                filter: 'moder',
                fields: 'screen_name,photo_50,photo_100',
                count: 100,
                v: '5.199',
            },
            timeout: 15_000,
        });
        if (data.error || !data.response?.items)
            return [];
        return data.response.items.map((g) => {
            const screenName = g.screen_name ?? `club${g.id}`;
            return {
                id: String(g.id),
                name: g.name?.trim() || `club${g.id}`,
                screenName,
                url: `https://vk.com/${screenName}`,
                photo: g.photo_100 ?? g.photo_50,
            };
        });
    }
    catch (err) {
        logger_1.logger.debug('listVkManagedGroups failed', err);
        return [];
    }
}
function mapTelegramChannelPost(msg) {
    const messageId = typeof msg.message_id === 'number' ? msg.message_id : 0;
    const text = typeof msg.text === 'string'
        ? msg.text
        : typeof msg.caption === 'string'
            ? msg.caption
            : '';
    const hasMedia = Array.isArray(msg.photo) || msg.video != null || msg.document != null;
    return {
        externalId: String(messageId),
        text,
        hasMedia,
        createdAt: typeof msg.date === 'number' ? msg.date * 1000 : undefined,
    };
}
function channelPostMatchesTarget(chat, channelId) {
    const targetId = channelId.replace(/^@/, '');
    const chatKey = typeof chat.username === 'string' ? chat.username.toLowerCase() : String(chat.id);
    return targetId.startsWith('-') || /^\d+$/.test(targetId)
        ? String(chat.id) === targetId
        : chatKey === targetId.toLowerCase().replace(/^@/, '');
}
function extractTelegramMessageFromUpdate(upd) {
    for (const key of ['channel_post', 'edited_channel_post', 'message', 'edited_message']) {
        const msg = upd[key];
        if (msg)
            return msg;
    }
    return undefined;
}
function isTelegramServiceMessage(msg) {
    return (msg.new_chat_members != null ||
        msg.left_chat_member != null ||
        msg.new_chat_title != null ||
        msg.pinned_message != null ||
        msg.group_chat_created != null ||
        msg.supergroup_chat_created != null ||
        msg.channel_chat_created != null);
}
const telegramFetchLocks = new Map();
async function withTelegramIntegrationLock(integrationId, fn) {
    const prev = telegramFetchLocks.get(integrationId) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    telegramFetchLocks.set(integrationId, prev.then(() => gate));
    await prev;
    try {
        return await fn();
    }
    finally {
        release();
        if (telegramFetchLocks.get(integrationId) === gate) {
            telegramFetchLocks.delete(integrationId);
        }
    }
}
async function warnIfTelegramWebhookActive(token) {
    try {
        const { data } = await axios_1.default.get(`${TG_API}/bot${token}/getWebhookInfo`, { timeout: 10_000 });
        const url = data.result?.url;
        if (data.ok && url && url.trim() !== '') {
            logger_1.logger.error('fetchTelegramChannelPosts: у бота включён webhook — getUpdates пустой. Удалите webhook: deleteWebhook', { webhookUrl: url });
        }
    }
    catch {
        /* ignore */
    }
}
async function probeTelegramChannelAccess(token, channelId) {
    try {
        const { data } = await axios_1.default.get(`${TG_API}/bot${token}/getChat`, {
            params: { chat_id: channelId },
            timeout: 15_000,
        });
        if (data.ok && data.result) {
            logger_1.logger.info('fetchTelegramChannelPosts: chat accessible via getChat', {
                channelId,
                title: data.result.title,
                type: data.result.type,
            });
        }
    }
    catch (err) {
        const axErr = axios_1.default.isAxiosError(err) ? err : null;
        logger_1.logger.error('fetchTelegramChannelPosts: chat not accessible', {
            channelId,
            error: axErr?.response?.data,
        });
    }
}
/**
 * Новые посты/сообщения из TG-канала, группы или супергруппы через getUpdates.
 * Каналы: channel_post; группы/чаты: message.
 *
 * Попутно собирает my_chat_member-события, где бот становится администратором,
 * и возвращает их в {@link discoveredChats} для немедленного обновления linkedChats.
 * Это необходимо, потому что оба механизма (опрос постов и обнаружение каналов)
 * используют один и тот же getUpdates offset — без такой инлайн-обработки
 * my_chat_member-события будут «съедены» поллером постов до того, как
 * listTelegramBotChats получит шанс их увидеть.
 */
async function fetchTelegramChannelPosts(token, integrationId, channelId, afterMessageId) {
    return withTelegramIntegrationLock(integrationId, async () => {
        await flowStateStore_1.flowStateStore.load();
        const trimmedToken = token.trim();
        await ensureTelegramPollingMode(trimmedToken);
        const useMainBotOffset = (0, resolveTelegramBotToken_1.isMainTelegramBotToken)(trimmedToken);
        const readOffset = useMainBotOffset
            ? (0, telegramMainBotOffsetStore_1.getTelegramBotUpdatesOffset)(trimmedToken)
            : flowStateStore_1.flowStateStore.getTelegramUpdateOffset(integrationId);
        try {
            const params = {
                limit: 100,
                timeout: 0,
            };
            if (readOffset !== undefined) {
                params.offset = readOffset;
            }
            const { data } = await axios_1.default.get(`${TG_API}/bot${trimmedToken}/getUpdates`, { params, timeout: 20_000 });
            if (!data.ok || !data.result?.length) {
                if (readOffset === undefined) {
                    await warnIfTelegramWebhookActive(token);
                }
                return { posts: [], lastMessageId: afterMessageId, discoveredChats: [] };
            }
            const posts = [];
            const newAdminChats = new Map();
            let maxMessageId = afterMessageId;
            let maxUpdateId = readOffset ?? 0;
            let matchedInBatch = 0;
            let seenForTarget = 0;
            for (const upd of data.result) {
                const updateId = typeof upd.update_id === 'number' ? upd.update_id : 0;
                if (updateId >= maxUpdateId) {
                    maxUpdateId = updateId + 1;
                }
                rememberTelegramStartedUserFromUpdate(upd);
                await (0, telegramMainBotUpdates_1.processMainTelegramBotMyChatMemberUpdate)(trimmedToken, upd);
                // Capture bot becoming admin in a channel/group so the caller can update linkedChats
                // immediately — without this, the event would be consumed by this loop and lost
                // before listTelegramBotChats ever gets a chance to see it.
                const mcm = upd.my_chat_member;
                if (mcm) {
                    const mcmChat = mcm.chat;
                    const newMember = mcm.new_chat_member;
                    const status = typeof newMember?.status === 'string' ? newMember.status : '';
                    if ((status === 'administrator' || status === 'creator') && mcmChat) {
                        mergeTelegramChat(newAdminChats, mcmChat, true);
                    }
                }
                const msg = extractTelegramMessageFromUpdate(upd);
                if (!msg || isTelegramServiceMessage(msg))
                    continue;
                const from = msg.from;
                if (from?.is_bot === true)
                    continue;
                const chat = msg.chat;
                if (!chat || !channelPostMatchesTarget(chat, channelId))
                    continue;
                seenForTarget += 1;
                const messageId = typeof msg.message_id === 'number' ? msg.message_id : 0;
                if (messageId > maxMessageId) {
                    maxMessageId = messageId;
                }
                if (messageId <= afterMessageId)
                    continue;
                matchedInBatch += 1;
                posts.push(mapTelegramChannelPost(msg));
            }
            const offsetBefore = readOffset ?? 0;
            if (maxUpdateId > offsetBefore) {
                if (useMainBotOffset) {
                    (0, telegramMainBotOffsetStore_1.setTelegramBotUpdatesOffset)(trimmedToken, maxUpdateId);
                }
                else {
                    await flowStateStore_1.flowStateStore.setTelegramUpdateOffset(integrationId, maxUpdateId);
                }
            }
            const discoveredChats = [...newAdminChats.values()];
            logger_1.logger.info('fetchTelegramChannelPosts: batch', {
                channelId,
                updates: data.result.length,
                seenForTarget,
                newPosts: posts.length,
                afterMessageId,
                lastMessageId: maxMessageId,
                newAdminChats: discoveredChats.length,
                offsetStore: useMainBotOffset ? 'tg_chain_reader_offsets' : 'flow-state.json',
            });
            if (posts.length === 0 && afterMessageId > 0 && seenForTarget === 0) {
                await probeTelegramChannelAccess(token, channelId);
            }
            return { posts, lastMessageId: maxMessageId, discoveredChats };
        }
        catch (err) {
            if (axios_1.default.isAxiosError(err) && err.response?.status === 409) {
                logger_1.logger.warn('fetchTelegramChannelPosts: 409 conflict — другой процесс уже опрашивает getUpdates (tgChainForwarder?)', { integrationId, channelId });
            }
            else {
                logger_1.logger.warn('fetchTelegramChannelPosts failed', err);
            }
            return { posts: [], lastMessageId: afterMessageId, discoveredChats: [] };
        }
    });
}
async function fetchVkWallPosts(token, groupId, afterPostId) {
    const ownerId = groupId.startsWith('-') ? groupId : `-${groupId.replace(/^public/, '')}`;
    try {
        const { data } = await axios_1.default.get('https://api.vk.com/method/wall.get', {
            params: {
                access_token: token,
                owner_id: ownerId,
                count: 20,
                filter: 'owner',
                v: '5.199',
            },
            timeout: 15_000,
        });
        if (data.error || !data.response?.items) {
            return { posts: [], lastPostId: afterPostId };
        }
        const posts = [];
        let maxId = afterPostId;
        for (const item of data.response.items) {
            const id = typeof item.id === 'number' ? item.id : 0;
            if (id > maxId)
                maxId = id;
            if (id <= afterPostId)
                continue;
            const text = typeof item.text === 'string' ? item.text : '';
            const attachments = item.attachments;
            const hasMedia = Array.isArray(attachments) && attachments.length > 0;
            posts.push({
                externalId: String(id),
                text,
                hasMedia,
                createdAt: typeof item.date === 'number' ? item.date * 1000 : undefined,
            });
        }
        return { posts, lastPostId: maxId };
    }
    catch (err) {
        logger_1.logger.warn('fetchVkWallPosts failed', err);
        return { posts: [], lastPostId: afterPostId };
    }
}
async function publishVkWallPost(token, groupId, message) {
    const ownerId = groupId.startsWith('-') ? groupId : `-${groupId.replace(/^public/, '')}`;
    const { data } = await axios_1.default.get('https://api.vk.com/method/wall.post', {
        params: {
            access_token: token,
            owner_id: ownerId,
            from_group: 1,
            message,
            v: '5.199',
        },
        timeout: 15_000,
    });
    if (data.error) {
        throw new Error(data.error.error_msg ?? 'VK wall.post failed');
    }
    return data.response?.post_id ?? null;
}
async function fetchVkWallComments(token, groupId, postId, afterCommentId) {
    const ownerId = groupId.startsWith('-') ? groupId : `-${groupId.replace(/^public/, '')}`;
    try {
        const { data } = await axios_1.default.get('https://api.vk.com/method/wall.getComments', {
            params: {
                access_token: token,
                owner_id: ownerId,
                post_id: postId,
                count: 100,
                sort: 'asc',
                thread_items_count: 10,
                v: '5.199',
            },
            timeout: 15_000,
        });
        if (data.error || !data.response?.items) {
            return { comments: [], lastCommentId: afterCommentId };
        }
        const comments = [];
        let maxId = afterCommentId;
        for (const item of data.response.items) {
            const id = typeof item.id === 'number' ? item.id : 0;
            if (id > maxId)
                maxId = id;
            if (id <= afterCommentId)
                continue;
            const text = typeof item.text === 'string' ? item.text : '';
            if (!text.trim())
                continue;
            comments.push({
                id,
                from_id: typeof item.from_id === 'number' ? item.from_id : 0,
                date: typeof item.date === 'number' ? item.date : 0,
                text,
                reply_to_comment: typeof item.reply_to_comment === 'number' ? item.reply_to_comment : undefined,
            });
        }
        return { comments, lastCommentId: maxId };
    }
    catch (err) {
        logger_1.logger.warn('fetchVkWallComments failed', { groupId, postId, err });
        return { comments: [], lastCommentId: afterCommentId };
    }
}
async function publishVkWallComment(token, groupId, postId, message, replyToCommentId) {
    const ownerId = groupId.startsWith('-') ? groupId : `-${groupId.replace(/^public/, '')}`;
    try {
        const params = {
            access_token: token,
            owner_id: ownerId,
            post_id: postId,
            message,
            from_group: Number(Math.abs(Number(ownerId))),
            v: '5.199',
        };
        if (replyToCommentId != null && replyToCommentId > 0) {
            params.reply_to_comment = replyToCommentId;
        }
        const { data } = await axios_1.default.get('https://api.vk.com/method/wall.createComment', { params, timeout: 15_000 });
        if (data.error) {
            logger_1.logger.warn('publishVkWallComment failed', { error: data.error.error_msg });
            return null;
        }
        return data.response?.comment_id ?? null;
    }
    catch (err) {
        logger_1.logger.warn('publishVkWallComment threw', { groupId, postId, err });
        return null;
    }
}
//# sourceMappingURL=integrationPlatformClient.js.map