"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncOwnerProfileFromMiniapp = syncOwnerProfileFromMiniapp;
exports.createChannelLinkDraft = createChannelLinkDraft;
exports.getChannelLinkDraftPreview = getChannelLinkDraftPreview;
exports.submitChannelLinkDraftFromTelegram = submitChannelLinkDraftFromTelegram;
exports.finalizeChannelLinkDraftInMax = finalizeChannelLinkDraftInMax;
exports.confirmChannelLinkDraft = confirmChannelLinkDraft;
exports.listChannelLinksForMaxUser = listChannelLinksForMaxUser;
exports.listChannelLinksForTelegramUser = listChannelLinksForTelegramUser;
exports.repairLegacyMiniappTgChains = repairLegacyMiniappTgChains;
exports.getOwnerProfileBundle = getOwnerProfileBundle;
const max_bot_api_1 = require("@maxhub/max-bot-api");
const adminPanelState_1 = require("../api/adminPanelState");
const channelLinkCallback_1 = require("../utils/channelLinkCallback");
const tgChainPair_1 = require("../utils/tgChainPair");
const channelRegistry_1 = require("./channelRegistry");
const channelLinkDraftStore_1 = require("./channelLinkDraftStore");
const channelPostActions_1 = require("./channelPostActions");
const integrationPlatformClient_1 = require("./integrationPlatformClient");
const ownerProfileStore_1 = require("./ownerProfileStore");
const resolveTelegramBotToken_1 = require("./resolveTelegramBotToken");
const stateManager_1 = require("./stateManager");
const telegramMiniappService_1 = require("./telegramMiniappService");
const telegramBotUserStore_1 = require("./telegramBotUserStore");
const telegramChannelRegistry_1 = require("./telegramChannelRegistry");
const logger_1 = require("../utils/logger");
function chainToWire(chain) {
    const tgTitle = chain.tg_channel_id != null
        ? (telegramChannelRegistry_1.telegramChannelRegistry.getChannel(chain.tg_channel_id)?.title ??
            chain.tg_username)
        : chain.tg_username;
    return {
        id: chain.id,
        tg_title: tgTitle || 'Telegram',
        tg_username: chain.tg_username,
        tg_channel_id: chain.tg_channel_id ?? null,
        max_chat_id: chain.max_chat_id,
        max_title: chain.max_title,
        active: chain.active,
        forward_posts: chain.forward_posts,
        add_comments_button: chain.add_comments_button !== false,
        forwarded_today: chain.forwarded_today,
        created_at: chain.created_at,
    };
}
function assertDraftNotExpired(draft) {
    const expiresMs = Date.parse(draft.expires_at);
    if (Number.isFinite(expiresMs) && expiresMs < Date.now()) {
        throw new Error('code expired');
    }
}
async function assertMaxChannelReady(bot, maxChatId, maxUserId) {
    const reg = channelRegistry_1.channelRegistry.getChannel(maxChatId);
    if (!reg) {
        throw new Error('max channel not connected');
    }
    if (stateManager_1.stateManager.isChannelPendingAdminRights(maxChatId)) {
        throw new Error('max channel pending admin rights');
    }
    if (!(await (0, channelPostActions_1.isUserChannelAdmin)(bot, maxChatId, maxUserId))) {
        throw new Error('forbidden');
    }
}
async function assertTelegramChannelReady(tgToken, tgChannelId, tgUserId) {
    const reg = telegramChannelRegistry_1.telegramChannelRegistry.getChannel(tgChannelId);
    if (!reg) {
        throw new Error('telegram channel not connected');
    }
    if (!reg.bot_is_admin) {
        throw new Error('telegram bot is not admin');
    }
    const admins = await (0, integrationPlatformClient_1.listTelegramChatAdministrators)(tgToken, tgChannelId);
    if (!admins.some((a) => a.userId === tgUserId)) {
        throw new Error('forbidden');
    }
    const username = typeof reg.username === 'string' && reg.username.trim() !== ''
        ? reg.username.replace(/^@/, '')
        : tgChannelId;
    return { tgUsername: username, tgTitle: reg.title };
}
async function sendMaxLinkConfirmRequest(bot, draft, tgTitle, tgUsername) {
    if (!bot) {
        return;
    }
    const maxLabel = (draft.max_title && draft.max_title.trim()) || 'MAX-канал';
    const tgLabel = (tgTitle && tgTitle.trim()) || 'Telegram-канал';
    const tgHandle = tgUsername ? `@${tgUsername.replace(/^@/, '')}` : '';
    const text = `📱 Запрос на связку с Telegram\n\n` +
        `Для MAX-канала «${maxLabel}» указан код ${draft.code}.\n\n` +
        `Telegram: «${tgLabel}»${tgHandle ? ` (${tgHandle})` : ''}\n\n` +
        `Если это вы — нажмите «Подтвердить связку». Посты из Telegram начнут пересылаться в MAX.`;
    const keyboard = max_bot_api_1.Keyboard.inlineKeyboard([
        [max_bot_api_1.Keyboard.button.callback('✅ Подтвердить связку', (0, channelLinkCallback_1.buildConfirmChannelLinkPayload)(draft.code))],
    ]);
    try {
        await bot.api.sendMessageToUser(draft.max_user_id, text, { attachments: [keyboard] });
        logger_1.logger.info('sendMaxLinkConfirmRequest: sent', {
            maxUserId: draft.max_user_id,
            code: draft.code,
        });
    }
    catch (err) {
        logger_1.logger.warn('sendMaxLinkConfirmRequest: send failed', {
            maxUserId: draft.max_user_id,
            code: draft.code,
            err,
        });
    }
}
async function finalizeDraftToChain(draft, tgChannelId, tgUsername, tgUserId) {
    const tgToken = (0, resolveTelegramBotToken_1.resolveTelegramBotToken)();
    const normalizedUsername = tgUsername.trim().replace(/^@/, '');
    const chain = await (0, adminPanelState_1.createTgChain)({
        max_chat_id: draft.max_chat_id,
        max_title: draft.max_title,
        tg_username: normalizedUsername,
        tg_channel_id: tgChannelId,
        bot_token: tgToken,
        forward_posts: draft.forward_posts !== false,
        forward_comments: true,
        add_comments_button: draft.add_comments_button !== false,
        add_signature: false,
        active: true,
        owner_profile_id: draft.profile_id,
        created_via: 'miniapp_link',
        max_user_id: draft.max_user_id,
        tg_user_id: tgUserId,
    });
    if (tgToken) {
        await (0, integrationPlatformClient_1.ensureTelegramPollingMode)(tgToken);
    }
    channelLinkDraftStore_1.channelLinkDraftStore.markCompleted(draft.code, {
        tgChannelId,
        tgUsername,
        tgUserId,
        chainId: chain.id,
    });
    return chain;
}
async function syncOwnerProfileFromMiniapp(platform, account) {
    const profileId = ownerProfileStore_1.ownerProfileStore.syncAccount(account);
    return { profile_id: profileId };
}
async function createChannelLinkDraft(bot, input) {
    await (0, adminPanelState_1.ensureAdminPanelStateLoaded)();
    await assertMaxChannelReady(bot, input.maxChatId, input.maxUserId);
    const reg = channelRegistry_1.channelRegistry.getChannel(input.maxChatId);
    const profileId = ownerProfileStore_1.ownerProfileStore.syncAccount(input.account);
    const draft = channelLinkDraftStore_1.channelLinkDraftStore.createDraft({
        profileId,
        maxChatId: input.maxChatId,
        maxUserId: input.maxUserId,
        maxTitle: reg?.title ?? null,
    });
    return {
        code: draft.code,
        expires_at: draft.expires_at,
        max_title: draft.max_title,
        profile_id: profileId,
    };
}
function getChannelLinkDraftPreview(code) {
    const draft = channelLinkDraftStore_1.channelLinkDraftStore.getByCode(code);
    if (!draft) {
        return null;
    }
    const expiresMs = Date.parse(draft.expires_at);
    if (Number.isFinite(expiresMs) && expiresMs < Date.now() && draft.status !== 'completed') {
        return {
            max_title: draft.max_title,
            tg_title: null,
            expires_at: draft.expires_at,
            status: 'expired',
        };
    }
    const tgTitle = draft.tg_channel_id != null
        ? (telegramChannelRegistry_1.telegramChannelRegistry.getChannel(draft.tg_channel_id)?.title ??
            draft.tg_username)
        : null;
    return {
        max_title: draft.max_title,
        tg_title: tgTitle,
        expires_at: draft.expires_at,
        status: draft.status,
    };
}
/** Шаг 1 (Telegram): указать канал и код — ждёт подтверждения в MAX. */
async function submitChannelLinkDraftFromTelegram(tgToken, input, options) {
    await (0, adminPanelState_1.ensureAdminPanelStateLoaded)();
    const normalizedCode = String(input.code).trim().toUpperCase();
    const draft = channelLinkDraftStore_1.channelLinkDraftStore.getByCode(normalizedCode);
    if (!draft) {
        throw new Error('invalid code');
    }
    if (draft.status === 'awaiting_max_confirm' && draft.tg_channel_id === input.tgChannelId.trim()) {
        const tgReg = telegramChannelRegistry_1.telegramChannelRegistry.getChannel(draft.tg_channel_id);
        return {
            status: 'awaiting_max_confirm',
            profile_id: draft.profile_id,
            max_title: draft.max_title,
            tg_title: tgReg?.title ?? draft.tg_username ?? 'Telegram',
        };
    }
    if (draft.status !== 'pending') {
        throw new Error('code not available');
    }
    assertDraftNotExpired(draft);
    const chatId = String(input.tgChannelId).trim();
    if (!/^-?\d+$/.test(chatId)) {
        throw new Error('invalid tg channel');
    }
    const { tgUsername, tgTitle } = await assertTelegramChannelReady(tgToken, chatId, input.tgUserId);
    const chains = await (0, adminPanelState_1.listTgChains)();
    const conflict = (0, tgChainPair_1.findActiveTgChainForPair)(chains, draft.max_chat_id, chatId, tgUsername);
    if (conflict) {
        throw new Error('pair already linked');
    }
    ownerProfileStore_1.ownerProfileStore.attachAccountToProfile(draft.profile_id, input.account);
    telegramBotUserStore_1.telegramBotUserStore.markStarted({ id: input.tgUserId });
    const forwardPosts = input.forwardPosts !== false;
    const addCommentsButton = input.addCommentsButton !== false;
    channelLinkDraftStore_1.channelLinkDraftStore.markAwaitingMaxConfirm(normalizedCode, {
        tgChannelId: chatId,
        tgUsername,
        tgUserId: input.tgUserId,
        forwardPosts,
        addCommentsButton,
    });
    await sendMaxLinkConfirmRequest(options?.maxBot, draft, tgTitle ?? tgUsername, tgUsername);
    return {
        status: 'awaiting_max_confirm',
        profile_id: draft.profile_id,
        max_title: draft.max_title,
        tg_title: tgTitle ?? tgUsername,
    };
}
/** Шаг 2 (MAX): кнопка «Подтвердить связку» — создаёт цепочку TG → MAX. */
async function finalizeChannelLinkDraftInMax(bot, code, maxUserId) {
    await (0, adminPanelState_1.ensureAdminPanelStateLoaded)();
    const normalizedCode = String(code).trim().toUpperCase();
    const draft = channelLinkDraftStore_1.channelLinkDraftStore.getByCode(normalizedCode);
    if (!draft) {
        throw new Error('invalid code');
    }
    if (draft.status !== 'awaiting_max_confirm') {
        throw new Error('not awaiting confirm');
    }
    assertDraftNotExpired(draft);
    if (draft.max_user_id !== maxUserId) {
        throw new Error('forbidden');
    }
    const chatId = draft.tg_channel_id?.trim() ?? '';
    const tgUsername = draft.tg_username?.trim() ?? '';
    const tgUserId = draft.tg_user_id;
    if (!chatId || !tgUsername || tgUserId == null) {
        throw new Error('draft incomplete');
    }
    await assertMaxChannelReady(bot, draft.max_chat_id, maxUserId);
    const chains = await (0, adminPanelState_1.listTgChains)();
    const conflict = (0, tgChainPair_1.findActiveTgChainForPair)(chains, draft.max_chat_id, chatId, tgUsername);
    if (conflict) {
        throw new Error('pair already linked');
    }
    const chain = await finalizeDraftToChain(draft, chatId, tgUsername, tgUserId);
    const tgReg = telegramChannelRegistry_1.telegramChannelRegistry.getChannel(chatId);
    const tgTitle = tgReg?.title ?? tgUsername;
    void (0, telegramMiniappService_1.notifyChannelLinkSucceededPrivate)({
        profileId: draft.profile_id,
        maxUserId: draft.max_user_id,
        maxTitle: draft.max_title,
        tgTitle,
        confirmedByTgUserId: tgUserId,
    }).catch((err) => {
        logger_1.logger.warn('finalizeChannelLinkDraftInMax: telegram notify failed', { err, code: normalizedCode });
    });
    return { chain: chainToWire(chain), profile_id: draft.profile_id };
}
/** @deprecated Use submit + finalize; kept for route name compatibility. */
async function confirmChannelLinkDraft(tgToken, input, options) {
    return submitChannelLinkDraftFromTelegram(tgToken, input, options);
}
async function listChannelLinksForMaxUser(bot, maxUserId) {
    await (0, adminPanelState_1.ensureAdminPanelStateLoaded)();
    const adminIds = new Set();
    const registered = channelRegistry_1.channelRegistry
        .getAllChannels()
        .filter((c) => c.type === 'channel')
        .map((c) => c.chat_id);
    for (const chatId of registered) {
        if (await (0, channelPostActions_1.isUserChannelAdmin)(bot, chatId, maxUserId)) {
            adminIds.add(chatId);
        }
    }
    const chains = await (0, adminPanelState_1.listTgChains)();
    return chains.filter((c) => adminIds.has(c.max_chat_id)).map(chainToWire);
}
async function listChannelLinksForTelegramUser(tgToken, tgUserId) {
    await (0, adminPanelState_1.ensureAdminPanelStateLoaded)();
    const { channels } = await (0, telegramMiniappService_1.listTelegramMiniappChannelsForUser)(tgUserId);
    const adminTgIds = new Set(channels.map((c) => c.chat_id));
    const chains = await (0, adminPanelState_1.listTgChains)();
    return chains
        .filter((c) => {
        const id = c.tg_channel_id?.trim();
        if (id && adminTgIds.has(id)) {
            return true;
        }
        return false;
    })
        .map(chainToWire);
}
/** Подставляет основной TG-токен в старые miniapp-цепочки с пустым bot_token. */
async function repairLegacyMiniappTgChains() {
    await (0, adminPanelState_1.ensureAdminPanelStateLoaded)();
    const token = (0, resolveTelegramBotToken_1.resolveTelegramBotToken)();
    if (!token) {
        return 0;
    }
    const chains = await (0, adminPanelState_1.listTgChains)();
    let repaired = 0;
    for (const chain of chains) {
        if (chain.created_via !== 'miniapp_link' || chain.bot_token?.trim()) {
            continue;
        }
        await (0, adminPanelState_1.updateTgChain)(chain.id, { bot_token: token });
        repaired += 1;
    }
    if (repaired > 0) {
        logger_1.logger.info('repairLegacyMiniappTgChains: bot_token restored', { repaired });
    }
    return repaired;
}
function getOwnerProfileBundle(profileId) {
    const accounts = ownerProfileStore_1.ownerProfileStore.getAccountsForProfile(profileId);
    return {
        profile_id: profileId,
        accounts: accounts.map((a) => ({
            platform: a.platform,
            platform_user_id: a.platform_user_id,
            username: a.username,
            first_name: a.first_name,
            last_name: a.last_name,
            photo_url: a.photo_url,
        })),
    };
}
//# sourceMappingURL=channelLinkService.js.map