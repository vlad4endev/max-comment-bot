"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listTelegramMiniappChannelsForUser = listTelegramMiniappChannelsForUser;
exports.getTelegramMiniappStats = getTelegramMiniappStats;
exports.getTelegramChannelAdminsForMiniapp = getTelegramChannelAdminsForMiniapp;
exports.resolveTelegramChannelInviteAccess = resolveTelegramChannelInviteAccess;
exports.registerTelegramChannelNotifyLink = registerTelegramChannelNotifyLink;
exports.notifyTelegramChannelJoined = notifyTelegramChannelJoined;
exports.postTelegramChannelAdminInvite = postTelegramChannelAdminInvite;
exports.handleTelegramBotStartJoin = handleTelegramBotStartJoin;
exports.handleTelegramMyChatMemberUpdate = handleTelegramMyChatMemberUpdate;
exports.processTelegramMiniappBotUpdates = processTelegramMiniappBotUpdates;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
const integrationsStore_1 = require("./integrationsStore");
const integrationPlatformClient_1 = require("./integrationPlatformClient");
const telegramBotUserStore_1 = require("./telegramBotUserStore");
const telegramChannelNotifyLinkStore_1 = require("./telegramChannelNotifyLinkStore");
const telegramChannelRegistry_1 = require("./telegramChannelRegistry");
const commentStore_1 = require("./commentStore");
const postStore_1 = require("./postStore");
const adminPanelState_1 = require("../api/adminPanelState");
const telegramDeeplink_1 = require("../utils/telegramDeeplink");
const logger_1 = require("../utils/logger");
const TG_API = 'https://api.telegram.org/bot';
function resolveTelegramBotToken() {
    const integ = integrationsStore_1.integrationsStore.getTelegramIntegration();
    const fromInteg = integ?.token?.trim() ?? '';
    if (fromInteg) {
        return fromInteg;
    }
    return (0, config_1.getTelegramToken)().trim();
}
async function sendTelegramBotMessage(token, chatId, text, extra) {
    await axios_1.default.post(`${TG_API}${token}/sendMessage`, {
        chat_id: chatId,
        text,
        ...(extra?.reply_markup ? { reply_markup: extra.reply_markup } : {}),
    }, { timeout: 15_000 });
}
async function isTelegramChannelAdmin(token, channelChatId, telegramUserId) {
    const admins = await (0, integrationPlatformClient_1.listTelegramChatAdministrators)(token, channelChatId);
    return admins.some((a) => a.userId === telegramUserId);
}
async function refreshTelegramChannelsCache(token) {
    const integration = integrationsStore_1.integrationsStore.getTelegramIntegration();
    const discovered = await (0, integrationPlatformClient_1.listTelegramBotChats)(token, integration?.id);
    const enriched = await (0, integrationPlatformClient_1.enrichTelegramChatsWithBotAdmin)(token, discovered);
    for (const ch of enriched) {
        if (ch.type !== 'channel' && ch.type !== 'supergroup') {
            continue;
        }
        telegramChannelRegistry_1.telegramChannelRegistry.saveChannel({
            chatId: ch.id,
            title: ch.title,
            username: ch.username,
            type: ch.type,
            botIsAdmin: ch.botIsAdmin === true,
        });
    }
}
async function listTelegramMiniappChannelsForUser(telegramUserId) {
    const token = resolveTelegramBotToken();
    if (!token) {
        return { channels: [], bot_username: 'commentvmax_bot' };
    }
    await integrationsStore_1.integrationsStore.load();
    await refreshTelegramChannelsCache(token);
    const registryRows = telegramChannelRegistry_1.telegramChannelRegistry.getAllChannels();
    const channels = [];
    for (const row of registryRows) {
        if (row.type !== 'channel' && row.type !== 'supergroup') {
            continue;
        }
        if (!(await isTelegramChannelAdmin(token, row.chat_id, telegramUserId))) {
            continue;
        }
        channels.push({
            chat_id: row.chat_id,
            title: row.title,
            subscribers: null,
            avatar_url: null,
            status: row.bot_is_admin ? 'active' : 'pending',
            platform: 'telegram',
        });
    }
    return { channels, bot_username: 'commentvmax_bot' };
}
async function getTelegramMiniappStats(telegramUserId) {
    const { channels } = await listTelegramMiniappChannelsForUser(telegramUserId);
    await (0, adminPanelState_1.ensureAdminPanelStateLoaded)();
    const chains = (0, adminPanelState_1.listTgChainsSync)().filter((c) => c.active);
    const adminTgIds = new Set(channels.map((c) => c.chat_id));
    const postIds = new Set();
    let posts = 0;
    for (const chain of chains) {
        const tgId = chain.tg_channel_id?.trim();
        if (!tgId || !adminTgIds.has(tgId)) {
            continue;
        }
        const maxChatId = chain.max_chat_id;
        const list = postStore_1.postStore.getPostsByChatId(maxChatId);
        posts += list.length;
        for (const p of list) {
            postIds.add(p.post_id);
        }
    }
    return {
        channels: channels.length,
        posts,
        comments: commentStore_1.commentStore.countForPostIds(postIds),
        bot_nickname: 'commentvmax_bot',
    };
}
async function getTelegramChannelAdminsForMiniapp(telegramUserId, channelChatId) {
    const token = resolveTelegramBotToken();
    const chatId = String(channelChatId).trim();
    const reg = telegramChannelRegistry_1.telegramChannelRegistry.getChannel(chatId);
    if (!reg) {
        throw new Error('channel not connected');
    }
    if (!(await isTelegramChannelAdmin(token, chatId, telegramUserId))) {
        throw new Error('forbidden');
    }
    const rows = await (0, integrationPlatformClient_1.listTelegramChatAdministrators)(token, chatId);
    const linkedIds = new Set(telegramChannelNotifyLinkStore_1.telegramChannelNotifyLinkStore.getUserIdsForChannel(chatId));
    const admins = rows.map((a) => {
        const name = a.name;
        const initials = name.trim().length >= 2
            ? name
                .trim()
                .split(/\s+/)
                .map((p) => p[0])
                .join('')
                .slice(0, 2)
                .toUpperCase()
            : name.slice(0, 2).toUpperCase();
        return {
            user_id: a.userId,
            name,
            initials,
            linked: linkedIds.has(a.userId),
        };
    });
    return {
        admins,
        invite_url: (0, telegramDeeplink_1.buildTelegramBotJoinUrl)(chatId),
    };
}
async function resolveTelegramChannelInviteAccess(telegramUserId, joinChannelIdRaw) {
    const chatId = String(joinChannelIdRaw).trim();
    if (!/^-?\d+$/.test(chatId)) {
        return { ok: false, status: 400, error: 'missing or invalid join_channel_id' };
    }
    const reg = telegramChannelRegistry_1.telegramChannelRegistry.getChannel(chatId);
    if (!reg) {
        return { ok: false, status: 404, error: 'channel is not connected to this bot' };
    }
    return { ok: true, channelChatId: chatId, title: reg.title };
}
async function registerTelegramChannelNotifyLink(telegramUserId, channelChatId) {
    const access = await resolveTelegramChannelInviteAccess(telegramUserId, channelChatId);
    if (!access.ok) {
        throw new Error(access.error);
    }
    const wasLinked = telegramChannelNotifyLinkStore_1.telegramChannelNotifyLinkStore.isLinked(telegramUserId, access.channelChatId);
    telegramChannelNotifyLinkStore_1.telegramChannelNotifyLinkStore.register(telegramUserId, access.channelChatId);
    telegramBotUserStore_1.telegramBotUserStore.markStarted({
        id: telegramUserId,
    });
    return {
        channel_title: access.title,
        already_linked: wasLinked,
    };
}
async function notifyTelegramChannelJoined(channelChatId) {
    const token = resolveTelegramBotToken();
    if (!token) {
        return;
    }
    const reg = telegramChannelRegistry_1.telegramChannelRegistry.getChannel(channelChatId);
    const title = reg?.title ?? 'канал';
    const homeUrl = process.env.MINI_APP_URL?.trim() || 'https://t.me/commentvmax_bot';
    const admins = await (0, integrationPlatformClient_1.listTelegramChatAdministrators)(token, channelChatId);
    const message = `✅ Канал подключён\n\n` +
        `«${title}» успешно связан с CommentBot в Telegram.\n\n` +
        `Уведомления о комментариях в связанном MAX-канале и настройки — в мини-приложении.`;
    const keyboard = {
        inline_keyboard: [[{ text: '💬 Открыть панель', url: homeUrl }]],
    };
    for (const admin of admins) {
        if (!admin.startedBot) {
            continue;
        }
        try {
            await sendTelegramBotMessage(token, admin.userId, message, { reply_markup: keyboard });
        }
        catch (err) {
            logger_1.logger.warn('notifyTelegramChannelJoined: send failed', {
                channelChatId,
                adminId: admin.userId,
                err,
            });
        }
    }
}
async function postTelegramChannelAdminInvite(channelChatId) {
    const token = resolveTelegramBotToken();
    if (!token) {
        return;
    }
    const joinUrl = (0, telegramDeeplink_1.buildTelegramBotJoinUrl)(channelChatId);
    const text = '👋 CommentBot подключён к каналу.\n\n' +
        'Администраторы: нажмите кнопку ниже, откройте чат с ботом и напишите любое сообщение — вы начнёте получать уведомления о комментариях.';
    try {
        await sendTelegramBotMessage(token, channelChatId, text, {
            reply_markup: {
                inline_keyboard: [[{ text: '🔔 Получать уведомления', url: joinUrl }]],
            },
        });
    }
    catch (err) {
        logger_1.logger.warn('postTelegramChannelAdminInvite: send failed', { channelChatId, err });
    }
}
async function handleTelegramBotStartJoin(telegramUserId, startPayload) {
    const token = resolveTelegramBotToken();
    const m = /^jointg(\d+)$/i.exec(String(startPayload).trim());
    const channelChatId = m ? `-${m[1]}` : '';
    if (!channelChatId) {
        return;
    }
    const access = await resolveTelegramChannelInviteAccess(telegramUserId, channelChatId);
    if (!access.ok) {
        await sendTelegramBotMessage(token, telegramUserId, 'Не удалось подключить канал. Убедитесь, что бот добавлен в канал как администратор.');
        return;
    }
    await registerTelegramChannelNotifyLink(telegramUserId, channelChatId);
    const title = access.title ?? 'канал';
    const text = `✅ Готово! Вы подключены к каналу «${title}».\n\n` +
        `Теперь вы будете получать уведомления о новых комментариях (в Telegram и в связанном MAX-канале).`;
    await sendTelegramBotMessage(token, telegramUserId, text);
}
async function handleTelegramMyChatMemberUpdate(update) {
    const mcm = update.my_chat_member;
    if (!mcm) {
        return;
    }
    const chat = mcm.chat;
    const member = mcm.new_chat_member;
    const status = typeof member?.status === 'string' ? member.status : '';
    if (!chat || typeof chat.id !== 'number' && typeof chat.id !== 'string') {
        return;
    }
    const chatId = String(chat.id);
    const chatType = typeof chat.type === 'string' ? chat.type : 'channel';
    if (chatType !== 'channel' && chatType !== 'supergroup') {
        return;
    }
    const isAdmin = status === 'administrator' || status === 'creator';
    const isMember = isAdmin || status === 'member';
    if (!isMember) {
        telegramChannelRegistry_1.telegramChannelRegistry.saveChannel({
            chatId,
            title: typeof chat.title === 'string' ? chat.title : null,
            username: typeof chat.username === 'string' ? `@${chat.username}` : null,
            type: chatType,
            botIsAdmin: false,
        });
        return;
    }
    const title = typeof chat.title === 'string' && chat.title.trim() !== '' ? chat.title.trim() : null;
    const username = typeof chat.username === 'string' && chat.username.trim() !== ''
        ? `@${chat.username.replace(/^@/, '')}`
        : null;
    const wasAdmin = telegramChannelRegistry_1.telegramChannelRegistry.getChannel(chatId)?.bot_is_admin === true;
    telegramChannelRegistry_1.telegramChannelRegistry.saveChannel({
        chatId,
        title,
        username,
        type: chatType,
        botIsAdmin: isAdmin,
    });
    if (isAdmin && !wasAdmin) {
        await postTelegramChannelAdminInvite(chatId);
        await notifyTelegramChannelJoined(chatId);
    }
}
async function processTelegramMiniappBotUpdates(token, updates) {
    const mainToken = resolveTelegramBotToken();
    if (!mainToken || token.trim() !== mainToken) {
        return;
    }
    await integrationsStore_1.integrationsStore.load();
    for (const upd of updates) {
        if (upd.my_chat_member) {
            await handleTelegramMyChatMemberUpdate(upd);
        }
        const message = upd.message;
        if (!message) {
            continue;
        }
        const chat = message.chat;
        const from = message.from;
        const text = typeof message.text === 'string' ? message.text.trim() : '';
        if (!chat || chat.type !== 'private' || !from || typeof from.id !== 'number') {
            continue;
        }
        telegramBotUserStore_1.telegramBotUserStore.markStarted({
            id: from.id,
            username: typeof from.username === 'string' ? from.username : undefined,
            first_name: typeof from.first_name === 'string' ? from.first_name : undefined,
            last_name: typeof from.last_name === 'string' ? from.last_name : undefined,
        });
        if (!text.startsWith('/start')) {
            continue;
        }
        const payload = text.replace(/^\/start\s*/i, '').trim();
        if (/^jointg\d+$/i.test(payload)) {
            await handleTelegramBotStartJoin(from.id, payload);
            continue;
        }
        if (/^linkmax$/i.test(payload)) {
            const homeUrl = process.env.MINI_APP_URL?.trim() || 'https://t.me/commentvmax_bot';
            await sendTelegramBotMessage(token, from.id, '🔗 Связка с MAX\n\nОткройте мини-приложение CommentBot → «Создать связку» → выберите Telegram-канал и введите код из MAX.', {
                reply_markup: {
                    inline_keyboard: [[{ text: '💬 Открыть мини-приложение', url: homeUrl }]],
                },
            });
        }
    }
}
//# sourceMappingURL=telegramMiniappService.js.map