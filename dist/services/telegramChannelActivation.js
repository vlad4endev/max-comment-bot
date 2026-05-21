"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.tryActivateTelegramChannelRegistration = tryActivateTelegramChannelRegistration;
exports.runTelegramChannelConnectAttempt = runTelegramChannelConnectAttempt;
exports.handleTelegramMyChatMemberUpdate = handleTelegramMyChatMemberUpdate;
exports.handleTelegramCallbackQuery = handleTelegramCallbackQuery;
exports.handleTelegramPrivateMessage = handleTelegramPrivateMessage;
const axios_1 = __importDefault(require("axios"));
const integrationsStore_1 = require("./integrationsStore");
const integrationPlatformClient_1 = require("./integrationPlatformClient");
const telegramBotUserStore_1 = require("./telegramBotUserStore");
const telegramChannelNotifyLinkStore_1 = require("./telegramChannelNotifyLinkStore");
const telegramChannelRegistry_1 = require("./telegramChannelRegistry");
const telegramChannelAdminJoinNotified_1 = require("./telegramChannelAdminJoinNotified");
const telegramChannelActivationState_1 = require("./telegramChannelActivationState");
const config_1 = require("../config");
const telegramDeeplink_1 = require("../utils/telegramDeeplink");
const telegramTgChainLifecycle_1 = require("./telegramTgChainLifecycle");
const logger_1 = require("../utils/logger");
const TG_API = 'https://api.telegram.org/bot';
let cachedBotUserId = null;
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
async function answerTelegramCallbackQuery(token, callbackQueryId, text) {
    await axios_1.default.post(`${TG_API}${token}/answerCallbackQuery`, {
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
    }, { timeout: 10_000 });
}
async function getBotTelegramUserId(token) {
    if (cachedBotUserId != null) {
        return cachedBotUserId;
    }
    try {
        const { data } = await axios_1.default.get(`${TG_API}${token}/getMe`, { timeout: 10_000 });
        const id = data.result?.id;
        if (typeof id === 'number' && Number.isInteger(id) && id > 0) {
            cachedBotUserId = id;
            return id;
        }
    }
    catch (err) {
        logger_1.logger.warn('getBotTelegramUserId: getMe failed', { err });
    }
    return null;
}
async function isBotTelegramChannelAdmin(token, channelChatId) {
    const botId = await getBotTelegramUserId(token);
    if (botId == null) {
        return false;
    }
    try {
        const { data } = await axios_1.default.get(`${TG_API}${token}/getChatMember`, {
            params: { chat_id: channelChatId, user_id: botId },
            timeout: 15_000,
        });
        const status = data.result?.status ?? '';
        return status === 'administrator' || status === 'creator';
    }
    catch (err) {
        logger_1.logger.warn('isBotTelegramChannelAdmin: getChatMember failed', { channelChatId, err });
        return false;
    }
}
function parseInviterUserId(mcm) {
    const from = mcm.from;
    const id = from?.id;
    return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : undefined;
}
function extractChatMeta(chat) {
    const chatId = String(chat.id);
    const chatType = typeof chat.type === 'string' ? chat.type : 'channel';
    const title = typeof chat.title === 'string' && chat.title.trim() !== '' ? chat.title.trim() : null;
    const username = typeof chat.username === 'string' && chat.username.trim() !== ''
        ? `@${chat.username.replace(/^@/, '')}`
        : null;
    return { chatId, title, username, chatType };
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
                inline_keyboard: [[{ text: '🔔 Получать уведомления о комментариях', url: joinUrl }]],
            },
        });
    }
    catch (err) {
        logger_1.logger.warn('postTelegramChannelAdminInvite: send failed', { channelChatId, err });
    }
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
        `Подключите уведомления и настройки в мини-приложении.`;
    const keyboard = {
        inline_keyboard: [[{ text: '💬 Открыть панель управления', url: homeUrl }]],
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
async function notifyTelegramAdminsBotLostAdminRights(channelChatId) {
    const token = resolveTelegramBotToken();
    if (!token) {
        return;
    }
    const reg = telegramChannelRegistry_1.telegramChannelRegistry.getChannel(channelChatId);
    const title = reg?.title ?? 'ваш канал';
    const text = `⚠️ CommentBot больше не администратор канала\n\n` +
        `Канал: «${title}»\n\n` +
        `С бота сняли права администратора — уведомления и интеграция временно недоступны.\n\n` +
        `Чтобы продолжить, снова назначьте @commentvmax_bot администратором канала и нажмите «Подтвердить подключение» в личке с ботом.`;
    const confirmPayload = (0, telegramDeeplink_1.buildTelegramConfirmChannelPayload)(channelChatId);
    const keyboard = {
        inline_keyboard: [[{ text: '✅ Подтвердить подключение', callback_data: confirmPayload }]],
    };
    const admins = await (0, integrationPlatformClient_1.listTelegramChatAdministrators)(token, channelChatId);
    for (const admin of admins) {
        if (!admin.startedBot) {
            continue;
        }
        try {
            await sendTelegramBotMessage(token, admin.userId, text, { reply_markup: keyboard });
        }
        catch (err) {
            logger_1.logger.warn('notifyTelegramAdminsBotLostAdminRights: send failed', {
                channelChatId,
                adminId: admin.userId,
                err,
            });
        }
    }
}
async function dmTelegramInviterAboutMissingAdmin(inviterUserId, channelChatId, channelTitle) {
    if (inviterUserId == null) {
        return;
    }
    const token = resolveTelegramBotToken();
    const title = channelTitle ?? 'ваш канал';
    const text = `📢 Канал «${title}»\n\n` +
        `Вы добавили CommentBot в этот канал — спасибо.\n\n` +
        `Чтобы бот мог работать с каналом, ему нужны права администратора.\n\n` +
        `1. Откройте настройки канала → администраторы → выдайте @commentvmax_bot права админа.\n` +
        `2. Нажмите кнопку ниже — я проверю доступ и завершу подключение.`;
    const keyboard = {
        inline_keyboard: [
            [
                {
                    text: '✅ Подтвердить подключение',
                    callback_data: (0, telegramDeeplink_1.buildTelegramConfirmChannelPayload)(channelChatId),
                },
            ],
        ],
    };
    try {
        await sendTelegramBotMessage(token, inviterUserId, text, { reply_markup: keyboard });
    }
    catch (err) {
        logger_1.logger.warn('dmTelegramInviterAboutMissingAdmin: send failed', {
            inviterUserId,
            channelChatId,
            err,
        });
    }
}
function linkInviterAsAdmin(inviterUserId, channelChatId) {
    if (inviterUserId == null) {
        return;
    }
    telegramBotUserStore_1.telegramBotUserStore.markStarted({ id: inviterUserId });
    telegramChannelNotifyLinkStore_1.telegramChannelNotifyLinkStore.register(inviterUserId, channelChatId);
}
async function tryActivateTelegramChannelRegistration(channelChatId, inviterUserId) {
    const token = resolveTelegramBotToken();
    if (!token) {
        return { status: 'pending', shouldNotifyMissingAdmin: false };
    }
    const reg = telegramChannelRegistry_1.telegramChannelRegistry.getChannel(channelChatId);
    const botIsAdmin = await isBotTelegramChannelAdmin(token, channelChatId);
    telegramChannelRegistry_1.telegramChannelRegistry.saveChannel({
        chatId: channelChatId,
        title: reg?.title ?? null,
        username: reg?.username ?? null,
        type: reg?.type ?? 'channel',
        botIsAdmin,
    });
    if (!botIsAdmin) {
        (0, telegramChannelAdminJoinNotified_1.clearTelegramAdminJoinNotified)(channelChatId);
        telegramChannelActivationState_1.telegramChannelActivationState.markChannelPendingAdminRights(channelChatId);
        return { status: 'pending', shouldNotifyMissingAdmin: true };
    }
    telegramChannelActivationState_1.telegramChannelActivationState.clearChannelPendingAdminRights(channelChatId);
    linkInviterAsAdmin(inviterUserId, channelChatId);
    const updatedReg = telegramChannelRegistry_1.telegramChannelRegistry.getChannel(channelChatId);
    await (0, telegramTgChainLifecycle_1.restoreTgChainsForTelegramChannelAdminRestored)({
        tgChannelChatId: channelChatId,
        tgTitle: updatedReg?.title ?? reg?.title ?? null,
        tgUsername: updatedReg?.username ?? reg?.username ?? null,
    });
    const wasConnectedBefore = (0, telegramChannelAdminJoinNotified_1.hasTelegramAdminJoinNotified)(channelChatId);
    if (!wasConnectedBefore) {
        await notifyTelegramChannelJoined(channelChatId);
        await postTelegramChannelAdminInvite(channelChatId);
        (0, telegramChannelAdminJoinNotified_1.markTelegramAdminJoinNotified)(channelChatId);
        logger_1.logger.info('telegramChannelActivation: channel registered', { channelChatId, inviterUserId });
        return { status: 'registered' };
    }
    logger_1.logger.info('telegramChannelActivation: channel reconnected', { channelChatId });
    return { status: 'reconnected' };
}
async function runTelegramChannelConnectAttempt(channelChatIds, actorUserId) {
    const lines = [];
    for (const channelChatId of channelChatIds) {
        const outcome = await tryActivateTelegramChannelRegistration(channelChatId, actorUserId);
        const reg = telegramChannelRegistry_1.telegramChannelRegistry.getChannel(channelChatId);
        const display = reg?.title ? `«${reg.title}»` : `канал ${channelChatId}`;
        if (outcome.status === 'registered') {
            lines.push(`✅ ${display} — подключение выполнено.`);
        }
        else if (outcome.status === 'reconnected') {
            lines.push(`✅ ${display} — канал снова подключён.`);
        }
        else {
            lines.push(`⏳ ${display} — пока нет прав администратора у бота. Выдайте @commentvmax_bot права админа в канале и снова нажмите «Подтвердить подключение» или отправьте /connect.`);
        }
    }
    return lines;
}
async function handleTelegramMyChatMemberUpdate(update) {
    const mcm = update.my_chat_member;
    if (!mcm) {
        return;
    }
    const chat = mcm.chat;
    const newMember = mcm.new_chat_member;
    const oldMember = mcm.old_chat_member;
    const newStatus = typeof newMember?.status === 'string' ? newMember.status : '';
    const oldStatus = typeof oldMember?.status === 'string' ? oldMember.status : '';
    if (!chat) {
        return;
    }
    const { chatId, title, username, chatType } = extractChatMeta(chat);
    if (chatType !== 'channel' && chatType !== 'supergroup') {
        return;
    }
    const inviterUserId = parseInviterUserId(mcm);
    const wasAdmin = telegramChannelRegistry_1.telegramChannelRegistry.getChannel(chatId)?.bot_is_admin === true;
    const isAdminNow = newStatus === 'administrator' || newStatus === 'creator';
    const isMemberNow = isAdminNow || newStatus === 'member';
    const isRemoved = newStatus === 'left' || newStatus === 'kicked' || newStatus === 'restricted';
    const lostAdminRights = wasAdmin && !isAdminNow;
    logger_1.logger.info('telegram my_chat_member', {
        chatId,
        oldStatus,
        newStatus,
        inviterUserId,
        lostAdminRights,
    });
    if (isRemoved) {
        telegramChannelRegistry_1.telegramChannelRegistry.saveChannel({
            chatId,
            title,
            username,
            type: chatType,
            botIsAdmin: false,
        });
        (0, telegramChannelAdminJoinNotified_1.clearTelegramAdminJoinNotified)(chatId);
        telegramChannelActivationState_1.telegramChannelActivationState.markChannelPendingAdminRights(chatId);
        if (lostAdminRights) {
            await (0, telegramTgChainLifecycle_1.pauseTgChainsForTelegramChannelLostAdmin)({
                tgChannelChatId: chatId,
                tgTitle: title,
                tgUsername: username,
            });
            await notifyTelegramAdminsBotLostAdminRights(chatId);
        }
        return;
    }
    if (!isMemberNow) {
        return;
    }
    telegramChannelRegistry_1.telegramChannelRegistry.saveChannel({
        chatId,
        title,
        username,
        type: chatType,
        botIsAdmin: isAdminNow,
    });
    if (lostAdminRights) {
        (0, telegramChannelAdminJoinNotified_1.clearTelegramAdminJoinNotified)(chatId);
        telegramChannelActivationState_1.telegramChannelActivationState.markChannelPendingAdminRights(chatId);
        await (0, telegramTgChainLifecycle_1.pauseTgChainsForTelegramChannelLostAdmin)({
            tgChannelChatId: chatId,
            tgTitle: title,
            tgUsername: username,
        });
        await notifyTelegramAdminsBotLostAdminRights(chatId);
        return;
    }
    if (inviterUserId != null) {
        telegramBotUserStore_1.telegramBotUserStore.markStarted({ id: inviterUserId });
    }
    const outcome = await tryActivateTelegramChannelRegistration(chatId, inviterUserId);
    if (outcome.status === 'pending' && outcome.shouldNotifyMissingAdmin) {
        const shouldDm = !isAdminNow &&
            (oldStatus === 'left' || oldStatus === 'kicked' || oldStatus === '' || !wasAdmin);
        if (shouldDm) {
            await dmTelegramInviterAboutMissingAdmin(inviterUserId, chatId, title);
        }
    }
}
async function handleTelegramCallbackQuery(update) {
    const cq = update.callback_query;
    if (!cq) {
        return;
    }
    const token = resolveTelegramBotToken();
    const data = typeof cq.data === 'string' ? cq.data.trim() : '';
    const from = cq.from;
    const userId = typeof from?.id === 'number' ? from.id : null;
    const callbackId = typeof cq.id === 'string' ? cq.id : null;
    if (!data || userId == null || !callbackId) {
        return;
    }
    const channelChatId = (0, telegramDeeplink_1.parseTelegramConfirmChannelPayload)(data);
    if (!channelChatId) {
        return;
    }
    try {
        await answerTelegramCallbackQuery(token, callbackId);
    }
    catch (err) {
        logger_1.logger.warn('handleTelegramCallbackQuery: answer failed', { err });
    }
    const lines = await runTelegramChannelConnectAttempt([channelChatId], userId);
    try {
        await sendTelegramBotMessage(token, userId, lines.join('\n'));
    }
    catch (err) {
        logger_1.logger.warn('handleTelegramCallbackQuery: reply failed', { userId, channelChatId, err });
    }
}
async function handleTelegramPrivateMessage(fromUserId, text) {
    const token = resolveTelegramBotToken();
    const trimmed = text.trim();
    const pendingJoin = telegramChannelActivationState_1.telegramChannelActivationState.getPendingAdminJoin(fromUserId);
    if (pendingJoin && !trimmed.startsWith('/')) {
        telegramChannelActivationState_1.telegramChannelActivationState.clearPendingAdminJoinForUser(fromUserId);
        telegramChannelNotifyLinkStore_1.telegramChannelNotifyLinkStore.register(fromUserId, pendingJoin);
        const title = telegramChannelRegistry_1.telegramChannelRegistry.getChannel(pendingJoin)?.title ?? pendingJoin;
        await sendTelegramBotMessage(token, fromUserId, `✅ Вы подключены к каналу «${title}»!\n\nТеперь вы будете получать уведомления о новых комментариях.`);
        return;
    }
    const parsedConnect = (0, telegramDeeplink_1.parseTelegramConnectCommand)(trimmed);
    if (parsedConnect === false) {
        return;
    }
    if (parsedConnect === undefined) {
        await sendTelegramBotMessage(token, fromUserId, 'Команда /connect: без параметров — проверить все каналы в ожидании; с цифрами — ID канала (например /connect 1001234567890).');
        return;
    }
    {
        const targets = parsedConnect.mode === 'one'
            ? [parsedConnect.channelChatId]
            : telegramChannelActivationState_1.telegramChannelActivationState.getPendingAdminChannelIds();
        if (targets.length === 0) {
            await sendTelegramBotMessage(token, fromUserId, 'Нет каналов, ожидающих подключения. Сначала добавьте @commentvmax_bot в канал (и выдайте права администратора).');
            return;
        }
        const lines = await runTelegramChannelConnectAttempt(targets, fromUserId);
        await sendTelegramBotMessage(token, fromUserId, lines.join('\n'));
    }
}
//# sourceMappingURL=telegramChannelActivation.js.map