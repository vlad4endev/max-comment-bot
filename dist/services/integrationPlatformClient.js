"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureTelegramPollingMode = ensureTelegramPollingMode;
exports.mergePlatformChannels = mergePlatformChannels;
exports.validateTelegramToken = validateTelegramToken;
exports.validateVkToken = validateVkToken;
exports.testIntegration = testIntegration;
exports.listTelegramBotChats = listTelegramBotChats;
exports.listTelegramAdminChannels = listTelegramAdminChannels;
exports.listVkGroups = listVkGroups;
exports.fetchTelegramChannelPosts = fetchTelegramChannelPosts;
exports.fetchVkWallPosts = fetchVkWallPosts;
exports.publishVkWallPost = publishVkWallPost;
const axios_1 = __importDefault(require("axios"));
const logger_1 = require("../utils/logger");
const flowStateStore_1 = require("./flowStateStore");
const TG_API = 'https://api.telegram.org';
const TELEGRAM_DISCOVERY_UPDATES = [
    'message',
    'edited_message',
    'channel_post',
    'edited_channel_post',
    'my_chat_member',
];
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
/** Чаты/каналы, с которыми бот взаимодействовал (из getUpdates + my_chat_member). */
async function listTelegramBotChats(token, integrationId) {
    const trimmed = token.trim();
    if (trimmed === '') {
        return [];
    }
    await ensureTelegramPollingMode(trimmed);
    const seen = new Map();
    await flowStateStore_1.flowStateStore.load();
    let offset = integrationId !== undefined
        ? flowStateStore_1.flowStateStore.getTelegramUpdateOffset(integrationId)
        : undefined;
    try {
        for (let page = 0; page < 8; page++) {
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
                ingestTelegramUpdate(seen, upd);
            }
            if (data.result.length < 100) {
                break;
            }
        }
        if (integrationId !== undefined && offset !== undefined) {
            await flowStateStore_1.flowStateStore.setTelegramUpdateOffset(integrationId, offset);
        }
    }
    catch (err) {
        logger_1.logger.warn('listTelegramBotChats: getUpdates failed', err);
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
async function listTelegramAdminChannels(token) {
    return listTelegramBotChats(token);
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
 */
async function fetchTelegramChannelPosts(token, integrationId, channelId, afterMessageId) {
    return withTelegramIntegrationLock(integrationId, async () => {
        await flowStateStore_1.flowStateStore.load();
        await ensureTelegramPollingMode(token.trim());
        try {
            const storedOffset = flowStateStore_1.flowStateStore.getTelegramUpdateOffset(integrationId);
            const params = {
                limit: 100,
                timeout: 0,
            };
            if (storedOffset !== undefined) {
                params.offset = storedOffset;
            }
            const { data } = await axios_1.default.get(`${TG_API}/bot${token}/getUpdates`, { params, timeout: 20_000 });
            if (!data.ok || !data.result?.length) {
                if (storedOffset === undefined) {
                    await warnIfTelegramWebhookActive(token);
                }
                return { posts: [], lastMessageId: afterMessageId };
            }
            const posts = [];
            let maxMessageId = afterMessageId;
            let maxUpdateId = storedOffset ?? 0;
            let matchedInBatch = 0;
            let seenForTarget = 0;
            for (const upd of data.result) {
                const updateId = typeof upd.update_id === 'number' ? upd.update_id : 0;
                if (updateId >= maxUpdateId) {
                    maxUpdateId = updateId + 1;
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
            if (maxUpdateId > (storedOffset ?? 0)) {
                await flowStateStore_1.flowStateStore.setTelegramUpdateOffset(integrationId, maxUpdateId);
            }
            logger_1.logger.info('fetchTelegramChannelPosts: batch', {
                channelId,
                updates: data.result.length,
                seenForTarget,
                newPosts: posts.length,
                afterMessageId,
                lastMessageId: maxMessageId,
            });
            if (posts.length === 0 && afterMessageId > 0 && seenForTarget === 0) {
                await probeTelegramChannelAccess(token, channelId);
            }
            return { posts, lastMessageId: maxMessageId };
        }
        catch (err) {
            logger_1.logger.warn('fetchTelegramChannelPosts failed', err);
            return { posts: [], lastMessageId: afterMessageId };
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
}
//# sourceMappingURL=integrationPlatformClient.js.map