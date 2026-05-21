"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncOwnerProfileFromMiniapp = syncOwnerProfileFromMiniapp;
exports.createChannelLinkDraft = createChannelLinkDraft;
exports.getChannelLinkDraftPreview = getChannelLinkDraftPreview;
exports.confirmChannelLinkDraft = confirmChannelLinkDraft;
exports.listChannelLinksForMaxUser = listChannelLinksForMaxUser;
exports.listChannelLinksForTelegramUser = listChannelLinksForTelegramUser;
exports.getOwnerProfileBundle = getOwnerProfileBundle;
const adminPanelState_1 = require("../api/adminPanelState");
const channelRegistry_1 = require("./channelRegistry");
const channelLinkDraftStore_1 = require("./channelLinkDraftStore");
const channelPostActions_1 = require("./channelPostActions");
const integrationPlatformClient_1 = require("./integrationPlatformClient");
const ownerProfileStore_1 = require("./ownerProfileStore");
const stateManager_1 = require("./stateManager");
const telegramMiniappService_1 = require("./telegramMiniappService");
const telegramChannelRegistry_1 = require("./telegramChannelRegistry");
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
function findActiveChainConflict(chains, maxChatId, tgChannelId, tgUsername) {
    const tgKey = tgChannelId.trim();
    const uname = tgUsername.trim().replace(/^@/, '').toLowerCase();
    return (chains.find((c) => c.active &&
        (c.max_chat_id === maxChatId ||
            (tgKey && c.tg_channel_id === tgKey) ||
            (!tgKey && uname && c.tg_username.toLowerCase() === uname))) ?? null);
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
async function syncOwnerProfileFromMiniapp(platform, account) {
    const profileId = ownerProfileStore_1.ownerProfileStore.syncAccount(account);
    return { profile_id: profileId };
}
async function createChannelLinkDraft(bot, input) {
    await (0, adminPanelState_1.ensureAdminPanelStateLoaded)();
    await assertMaxChannelReady(bot, input.maxChatId, input.maxUserId);
    const chains = await (0, adminPanelState_1.listTgChains)();
    const existing = chains.find((c) => c.active && c.max_chat_id === input.maxChatId);
    if (existing) {
        throw new Error('max channel already linked');
    }
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
    if (draft.status !== 'pending') {
        return { max_title: draft.max_title, expires_at: draft.expires_at, status: draft.status };
    }
    const expiresMs = Date.parse(draft.expires_at);
    if (Number.isFinite(expiresMs) && expiresMs < Date.now()) {
        return { max_title: draft.max_title, expires_at: draft.expires_at, status: 'expired' };
    }
    return { max_title: draft.max_title, expires_at: draft.expires_at, status: 'pending' };
}
async function confirmChannelLinkDraft(tgToken, input) {
    await (0, adminPanelState_1.ensureAdminPanelStateLoaded)();
    const normalizedCode = String(input.code).trim().toUpperCase();
    const draft = channelLinkDraftStore_1.channelLinkDraftStore.getByCode(normalizedCode);
    if (!draft) {
        throw new Error('invalid code');
    }
    if (draft.status !== 'pending') {
        throw new Error('code not available');
    }
    const expiresMs = Date.parse(draft.expires_at);
    if (Number.isFinite(expiresMs) && expiresMs < Date.now()) {
        throw new Error('code expired');
    }
    const chatId = String(input.tgChannelId).trim();
    if (!/^-?\d+$/.test(chatId)) {
        throw new Error('invalid tg channel');
    }
    const { tgUsername } = await assertTelegramChannelReady(tgToken, chatId, input.tgUserId);
    const chains = await (0, adminPanelState_1.listTgChains)();
    const conflict = findActiveChainConflict(chains, draft.max_chat_id, chatId, tgUsername);
    if (conflict) {
        throw new Error('pair already linked');
    }
    ownerProfileStore_1.ownerProfileStore.attachAccountToProfile(draft.profile_id, input.account);
    const chain = await (0, adminPanelState_1.createTgChain)({
        max_chat_id: draft.max_chat_id,
        max_title: draft.max_title,
        tg_username: tgUsername,
        tg_channel_id: chatId,
        bot_token: '',
        forward_posts: input.forwardPosts !== false,
        forward_comments: false,
        add_comments_button: input.addCommentsButton !== false,
        add_signature: false,
        active: true,
        owner_profile_id: draft.profile_id,
        created_via: 'miniapp_link',
        max_user_id: draft.max_user_id,
        tg_user_id: input.tgUserId,
    });
    channelLinkDraftStore_1.channelLinkDraftStore.markCompleted(normalizedCode, {
        tgChannelId: chatId,
        tgUsername,
        tgUserId: input.tgUserId,
        chainId: chain.id,
    });
    return { chain: chainToWire(chain), profile_id: draft.profile_id };
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