"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendTelegramHowItWorksMessage = sendTelegramHowItWorksMessage;
exports.handleTelegramBotStartWelcome = handleTelegramBotStartWelcome;
exports.listTelegramMiniappChannelsForUser = listTelegramMiniappChannelsForUser;
exports.getTelegramMiniappStats = getTelegramMiniappStats;
exports.getTelegramChannelAdminsForMiniapp = getTelegramChannelAdminsForMiniapp;
exports.resolveTelegramChannelInviteAccess = resolveTelegramChannelInviteAccess;
exports.registerTelegramChannelNotifyLink = registerTelegramChannelNotifyLink;
exports.notifyChannelLinkSucceededPrivate = notifyChannelLinkSucceededPrivate;
exports.handleTelegramBotAccountPair = handleTelegramBotAccountPair;
exports.handleTelegramBotStartJoin = handleTelegramBotStartJoin;
exports.processTelegramMiniappBotUpdates = processTelegramMiniappBotUpdates;
const axios_1 = __importDefault(require("axios"));
const integrationsStore_1 = require("./integrationsStore");
const resolveTelegramBotToken_1 = require("./resolveTelegramBotToken");
const integrationPlatformClient_1 = require("./integrationPlatformClient");
const ownerProfileStore_1 = require("./ownerProfileStore");
const telegramBotUserStore_1 = require("./telegramBotUserStore");
const telegramChannelNotifyLinkStore_1 = require("./telegramChannelNotifyLinkStore");
const telegramChannelRegistry_1 = require("./telegramChannelRegistry");
const commentStore_1 = require("./commentStore");
const postStore_1 = require("./postStore");
const adminPanelState_1 = require("../api/adminPanelState");
const accountPairingService_1 = require("./accountPairingService");
const telegramDeeplink_1 = require("../utils/telegramDeeplink");
const telegramChannelActivation_1 = require("./telegramChannelActivation");
const channelLinkAdminTeamSync_1 = require("./channelLinkAdminTeamSync");
const telegramMiniAppUrl_1 = require("../utils/telegramMiniAppUrl");
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
const TG_API = 'https://api.telegram.org/bot';
async function sendTelegramBotMessage(token, chatId, text, extra) {
    await axios_1.default.post(`${TG_API}${token}/sendMessage`, {
        chat_id: chatId,
        text,
        ...(extra?.reply_markup ? { reply_markup: extra.reply_markup } : {}),
    }, { timeout: 15_000 });
}
async function answerTelegramCallbackQuery(token, callbackQueryId) {
    await axios_1.default.post(`${TG_API}${token}/answerCallbackQuery`, { callback_query_id: callbackQueryId }, { timeout: 10_000 });
}
function buildTelegramMiniAppHomeUrl() {
    const fromConfig = config_1.config.miniAppUrl?.trim();
    if (fromConfig && (0, telegramMiniAppUrl_1.isTelegramWebAppUrl)(fromConfig)) {
        return (0, telegramMiniAppUrl_1.withTelegramMiniappPlatform)((0, telegramMiniAppUrl_1.normalizeMiniAppUrl)(fromConfig) ?? fromConfig);
    }
    const fromEnv = (0, telegramMiniAppUrl_1.normalizeMiniAppUrl)(process.env.MINI_APP_URL ?? '');
    if (fromEnv && (0, telegramMiniAppUrl_1.isTelegramWebAppUrl)(fromEnv)) {
        return (0, telegramMiniAppUrl_1.withTelegramMiniappPlatform)(fromEnv);
    }
    return null;
}
function buildTelegramStartInlineKeyboard(homeUrl, options) {
    const openBtn = (0, telegramMiniAppUrl_1.buildTelegramOpenPanelButton)(homeUrl);
    const rows = [[openBtn]];
    if (options?.includeHowItWorks !== false) {
        rows.push([{ text: '📖 Как это работает', callback_data: 'tg_how_it_works' }]);
    }
    return { inline_keyboard: rows };
}
function resolveTelegramUserFirstName(from) {
    const first = typeof from?.first_name === 'string' ? from.first_name.trim() : '';
    if (first) {
        return first;
    }
    const username = typeof from?.username === 'string' ? from.username.trim() : '';
    if (username) {
        return username;
    }
    return 'друг';
}
async function getTelegramUserActivitySummary(telegramUserId) {
    const token = (0, resolveTelegramBotToken_1.resolveTelegramBotToken)();
    const notifyLinks = telegramChannelNotifyLinkStore_1.telegramChannelNotifyLinkStore.getLinkedChannels(telegramUserId);
    if (!token) {
        const notifyLinksCount = notifyLinks.length;
        return {
            channelsCount: 0,
            linksCount: 0,
            notifyLinksCount,
            isActive: notifyLinksCount > 0,
        };
    }
    await integrationsStore_1.integrationsStore.load();
    const { channels } = await listTelegramMiniappChannelsForUser(telegramUserId);
    await (0, adminPanelState_1.ensureAdminPanelStateLoaded)();
    const adminTgIds = new Set(channels.map((c) => c.chat_id));
    const linksCount = (0, adminPanelState_1.listTgChainsSync)().filter((c) => {
        const id = c.tg_channel_id?.trim();
        return Boolean(id && adminTgIds.has(id));
    }).length;
    const channelsCount = channels.length;
    const notifyLinksCount = notifyLinks.length;
    return {
        channelsCount,
        linksCount,
        notifyLinksCount,
        isActive: channelsCount > 0 || linksCount > 0 || notifyLinksCount > 0,
    };
}
async function sendTelegramHowItWorksMessage(token, telegramUserId) {
    const homeUrl = buildTelegramMiniAppHomeUrl();
    const text = `📖 Как работает CommentBot в Telegram:\n\n` +
        `1️⃣ Добавьте @commentvmax_bot в канал и выдайте права администратора\n` +
        `2️⃣ В мини-приложении создайте связку с каналом в MAX\n` +
        `3️⃣ Посты из Telegram пересылаются в MAX, под ними — кнопка «Комментарии»\n` +
        `4️⃣ Вы получаете уведомления о новых комментариях\n` +
        `5️⃣ Отвечаете из одной панели — в Telegram и MAX`;
    await sendTelegramBotMessage(token, telegramUserId, text, {
        reply_markup: buildTelegramStartInlineKeyboard(homeUrl, { includeHowItWorks: false }),
    });
}
async function handleTelegramBotStartWelcome(telegramUserId, from) {
    const token = (0, resolveTelegramBotToken_1.resolveTelegramBotToken)();
    if (!token) {
        return;
    }
    const firstName = resolveTelegramUserFirstName(from);
    const homeUrl = buildTelegramMiniAppHomeUrl();
    const activity = await getTelegramUserActivitySummary(telegramUserId);
    if (!activity.isActive) {
        const text = `👋 Привет, ${firstName}!\n\n` +
            `Я CommentBot — помогу связать ваш канал в Telegram с каналом в MAX.\n\n` +
            `Что можно сделать:\n` +
            `📢 Подключить Telegram-канал к боту\n` +
            `🔗 Создать связку TG ↔ MAX\n` +
            `🔔 Получать уведомления о комментариях\n\n` +
            `Нажмите кнопку ниже — откроется панель с пошаговым подключением.`;
        await sendTelegramBotMessage(token, telegramUserId, text, {
            reply_markup: buildTelegramStartInlineKeyboard(homeUrl),
        });
        return;
    }
    const parts = [];
    if (activity.channelsCount > 0) {
        parts.push(`${activity.channelsCount} ${activity.channelsCount === 1 ? 'канал' : activity.channelsCount < 5 ? 'канала' : 'каналов'}`);
    }
    if (activity.linksCount > 0) {
        parts.push(`${activity.linksCount} ${activity.linksCount === 1 ? 'связка' : activity.linksCount < 5 ? 'связки' : 'связок'}`);
    }
    if (activity.notifyLinksCount > 0 && activity.channelsCount === 0) {
        parts.push('уведомления включены');
    }
    const summary = parts.length > 0 ? parts.join(' · ') : 'есть подключения';
    const text = `👋 С возвращением, ${firstName}!\n\n` +
        `У вас уже настроено: ${summary}.\n\n` +
        `Откройте панель в мини-приложении — там каналы, связки TG↔MAX, статистика и настройки уведомлений.`;
    await sendTelegramBotMessage(token, telegramUserId, text, {
        reply_markup: buildTelegramStartInlineKeyboard(homeUrl, { includeHowItWorks: false }),
    });
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
    const token = (0, resolveTelegramBotToken_1.resolveTelegramBotToken)();
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
        await (0, telegramChannelActivation_1.reconcileTelegramChannelForMiniappUser)(row.chat_id, telegramUserId);
        const fresh = telegramChannelRegistry_1.telegramChannelRegistry.getChannel(row.chat_id);
        channels.push({
            chat_id: row.chat_id,
            title: fresh?.title ?? row.title,
            subscribers: null,
            avatar_url: null,
            status: fresh?.bot_is_admin ? 'active' : 'pending',
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
    const token = (0, resolveTelegramBotToken_1.resolveTelegramBotToken)();
    const chatId = String(channelChatId).trim();
    const reg = telegramChannelRegistry_1.telegramChannelRegistry.getChannel(chatId);
    if (!reg) {
        throw new Error('channel not connected');
    }
    if (!(await isTelegramChannelAdmin(token, chatId, telegramUserId))) {
        throw new Error('forbidden');
    }
    const [rows, botUserId] = await Promise.all([
        (0, integrationPlatformClient_1.listTelegramChatAdministrators)(token, chatId),
        (0, integrationPlatformClient_1.getTelegramBotUserId)(token),
    ]);
    const linkedIds = new Set(telegramChannelNotifyLinkStore_1.telegramChannelNotifyLinkStore.getUserIdsForChannel(chatId));
    const admins = rows
        .filter((a) => botUserId == null || a.userId !== botUserId)
        .map((a) => {
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
        const pairing = (0, channelLinkAdminTeamSync_1.profilePairingForPlatformUser)('telegram', a.userId);
        const peerPlatform = pairing.max_user_id != null ? 'max' : pairing.paired ? 'max' : null;
        return {
            user_id: a.userId,
            name,
            initials,
            linked: linkedIds.has(a.userId),
            paired: pairing.paired,
            max_user_id: pairing.max_user_id,
            tg_user_id: pairing.tg_user_id,
            peer_platform: peerPlatform,
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
/** Личные сообщения в Telegram-боте после успешной связки TG ↔ MAX. */
async function notifyChannelLinkSucceededPrivate(params) {
    const token = (0, resolveTelegramBotToken_1.resolveTelegramBotToken)();
    if (!token) {
        return;
    }
    const maxTitle = (params.maxTitle && params.maxTitle.trim()) || 'MAX-канал';
    const tgTitle = (params.tgTitle && params.tgTitle.trim()) || 'Telegram-канал';
    const homeUrl = buildTelegramMiniAppHomeUrl();
    const keyboard = buildTelegramStartInlineKeyboard(homeUrl, { includeHowItWorks: false });
    const accounts = ownerProfileStore_1.ownerProfileStore.getAccountsForProfile(params.profileId);
    const maxOnProfile = accounts.some((a) => a.platform === 'max' && a.platform_user_id === String(params.maxUserId));
    const recipientRoles = new Map();
    recipientRoles.set(params.confirmedByTgUserId, 'confirmer');
    for (const acc of accounts) {
        if (acc.platform !== 'telegram') {
            continue;
        }
        const tgId = Number.parseInt(acc.platform_user_id, 10);
        if (!Number.isInteger(tgId) || tgId <= 0) {
            continue;
        }
        if (tgId === params.confirmedByTgUserId) {
            recipientRoles.set(tgId, 'confirmer');
        }
        else if (maxOnProfile) {
            recipientRoles.set(tgId, 'max_initiator');
        }
    }
    telegramBotUserStore_1.telegramBotUserStore.markStarted({ id: params.confirmedByTgUserId });
    for (const [tgId, role] of recipientRoles) {
        const text = role === 'max_initiator'
            ? `✅ Связка с Telegram завершена!\n\n📺 MAX: «${maxTitle}»\n📱 Telegram: «${tgTitle}»\n\nПосты из Telegram будут пересылаться в ваш MAX-канал.`
            : `✅ Связка создана!\n\n📱 Telegram: «${tgTitle}»\n📺 MAX: «${maxTitle}»\n\nПосты из Telegram будут пересылаться в MAX.`;
        try {
            await sendTelegramBotMessage(token, tgId, text, { reply_markup: keyboard });
            logger_1.logger.info('notifyChannelLinkSucceededPrivate: sent', { tgId, role });
        }
        catch (err) {
            logger_1.logger.warn('notifyChannelLinkSucceededPrivate: send failed', { tgId, role, err });
        }
    }
}
async function handleTelegramBotAccountPair(telegramUserId, from, startPayload) {
    const token = (0, resolveTelegramBotToken_1.resolveTelegramBotToken)();
    const firstName = typeof from.first_name === 'string' ? from.first_name : null;
    const lastName = typeof from.last_name === 'string' ? from.last_name : null;
    const username = typeof from.username === 'string' ? from.username : null;
    try {
        await (0, accountPairingService_1.completeAccountPairingFromTelegram)(startPayload, {
            platform: 'telegram',
            platformUserId: telegramUserId,
            username,
            firstName,
            lastName,
            photoUrl: null,
        });
        const homeUrl = buildTelegramMiniAppHomeUrl();
        await sendTelegramBotMessage(token, telegramUserId, '✅ Telegram привязан к вашему MAX-аккаунту!\n\n' +
            'Теперь команда канала видит связку в списке админов. Откройте мини-приложение — статус обновится автоматически.', { reply_markup: buildTelegramStartInlineKeyboard(homeUrl, { includeHowItWorks: false }) });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        let text = 'Не удалось привязать Telegram. Ссылка могла устареть — создайте новую в MAX.';
        if (msg === 'pairing token expired') {
            text = 'Ссылка устарела. В MAX нажмите «Связать Telegram» ещё раз.';
        }
        else if (msg === 'pairing token already used') {
            text = 'Эта ссылка уже использована. Если нужно — создайте новую в MAX.';
        }
        else if (msg === 'telegram already linked') {
            text = 'Telegram уже привязан к профилю.';
        }
        await sendTelegramBotMessage(token, telegramUserId, text);
    }
}
async function handleTelegramBotStartJoin(telegramUserId, startPayload) {
    const token = (0, resolveTelegramBotToken_1.resolveTelegramBotToken)();
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
async function processTelegramMiniappBotUpdates(token, updates) {
    const mainToken = (0, resolveTelegramBotToken_1.resolveTelegramBotToken)();
    if (!mainToken || token.trim() !== mainToken) {
        return;
    }
    await integrationsStore_1.integrationsStore.load();
    for (const upd of updates) {
        if (upd.my_chat_member) {
            await (0, telegramChannelActivation_1.handleTelegramMyChatMemberUpdate)(upd);
        }
        if (upd.callback_query) {
            const cq = upd.callback_query;
            const cqData = typeof cq.data === 'string' ? cq.data.trim() : '';
            const cqFrom = cq.from;
            const cqUserId = typeof cqFrom?.id === 'number' ? cqFrom.id : null;
            const cqId = typeof cq.id === 'string' ? cq.id : null;
            if (cqData === 'tg_how_it_works' && cqUserId != null && cqId) {
                try {
                    await answerTelegramCallbackQuery(token, cqId);
                }
                catch (err) {
                    logger_1.logger.warn('processTelegramMiniappBotUpdates: answer tg_how_it_works failed', { err });
                }
                await sendTelegramHowItWorksMessage(token, cqUserId);
                continue;
            }
            await (0, telegramChannelActivation_1.handleTelegramCallbackQuery)(upd);
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
        if (text.startsWith('/start')) {
            const payload = text.replace(/^\/start\s*/i, '').trim();
            if ((0, telegramDeeplink_1.isTelegramAccountPairStartPayload)(payload)) {
                await handleTelegramBotAccountPair(from.id, from, payload);
                continue;
            }
            if (/^jointg\d+$/i.test(payload)) {
                await handleTelegramBotStartJoin(from.id, payload);
                continue;
            }
            if (/^linkmax$/i.test(payload)) {
                const homeUrl = buildTelegramMiniAppHomeUrl();
                await sendTelegramBotMessage(token, from.id, '🔗 Связка с MAX\n\nОткройте мини-приложение CommentBot → «Создать связку» → выберите Telegram-канал и введите код из MAX.', {
                    reply_markup: buildTelegramStartInlineKeyboard(homeUrl, { includeHowItWorks: false }),
                });
                continue;
            }
            await handleTelegramBotStartWelcome(from.id, from);
            continue;
        }
        if (text) {
            await (0, telegramChannelActivation_1.handleTelegramPrivateMessage)(from.id, text);
        }
    }
}
//# sourceMappingURL=telegramMiniappService.js.map