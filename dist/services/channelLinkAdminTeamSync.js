"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.profilePairingForPlatformUser = profilePairingForPlatformUser;
exports.syncChannelLinkAdminTeam = syncChannelLinkAdminTeam;
exports.syncAllChannelLinkAdminTeamsForUser = syncAllChannelLinkAdminTeamsForUser;
const adminPanelState_1 = require("../api/adminPanelState");
const channelNotifyLinkStore_1 = require("./channelNotifyLinkStore");
const channelPostActions_1 = require("./channelPostActions");
const integrationPlatformClient_1 = require("./integrationPlatformClient");
const ownerProfileStore_1 = require("./ownerProfileStore");
const settingsStore_1 = require("./settingsStore");
const telegramChannelNotifyLinkStore_1 = require("./telegramChannelNotifyLinkStore");
const telegramChannelRegistry_1 = require("./telegramChannelRegistry");
const logger_1 = require("../utils/logger");
function profilePairingForPlatformUser(platform, userId) {
    const profileId = ownerProfileStore_1.ownerProfileStore.getProfileId(platform, userId);
    if (!profileId) {
        return { paired: false, max_user_id: null, tg_user_id: null };
    }
    const accounts = ownerProfileStore_1.ownerProfileStore.getAccountsForProfile(profileId);
    const maxAcc = accounts.find((a) => a.platform === 'max');
    const tgAcc = accounts.find((a) => a.platform === 'telegram');
    const maxUserId = maxAcc ? Number.parseInt(maxAcc.platform_user_id, 10) : Number.NaN;
    const tgUserId = tgAcc ? Number.parseInt(tgAcc.platform_user_id, 10) : Number.NaN;
    return {
        paired: !!(maxAcc && tgAcc),
        max_user_id: Number.isInteger(maxUserId) && maxUserId > 0 ? maxUserId : null,
        tg_user_id: Number.isInteger(tgUserId) && tgUserId > 0 ? tgUserId : null,
    };
}
function normUsername(raw) {
    if (typeof raw !== 'string') {
        return null;
    }
    const t = raw.trim().replace(/^@/, '').toLowerCase();
    return t === '' ? null : t;
}
async function listMaxChannelAdmins(bot, maxChatId) {
    try {
        const { members } = await bot.api.getChatAdmins(maxChatId);
        const rows = [];
        for (const m of members) {
            if (m.is_bot || (!m.is_admin && !m.is_owner)) {
                continue;
            }
            rows.push({
                platform: 'max',
                userId: m.user_id,
                name: m.name?.trim() || `ID ${m.user_id}`,
                username: m.username ?? null,
            });
        }
        if (rows.length > 0) {
            return rows;
        }
    }
    catch (err) {
        logger_1.logger.warn('channelLinkAdminTeamSync: getChatAdmins failed', { maxChatId, err });
    }
    const byId = new Map();
    let marker;
    for (let page = 0; page < 100; page += 1) {
        const res = await bot.api.getChatMembers(maxChatId, {
            count: 100,
            ...(marker !== undefined ? { marker } : {}),
        });
        for (const m of res.members) {
            if (!m.is_bot && (m.is_admin || m.is_owner)) {
                byId.set(m.user_id, m);
            }
        }
        const next = res.marker;
        if (next === undefined || next === null) {
            break;
        }
        marker = next;
    }
    return [...byId.values()].map((m) => ({
        platform: 'max',
        userId: m.user_id,
        name: m.name?.trim() || `ID ${m.user_id}`,
        username: m.username ?? null,
    }));
}
function toOwnerAccount(row) {
    if (row.platform === 'max') {
        return {
            platform: 'max',
            platformUserId: row.userId,
            username: row.username,
            firstName: row.name,
            lastName: null,
            photoUrl: null,
        };
    }
    const parts = row.name.trim().split(/\s+/);
    const firstName = parts[0] ?? row.name;
    const lastName = parts.length > 1 ? parts.slice(1).join(' ') : null;
    return {
        platform: 'telegram',
        platformUserId: row.userId,
        username: row.username,
        firstName,
        lastName,
        photoUrl: null,
    };
}
async function assertActorMaySyncChain(bot, tgToken, chain, actorMaxUserId, actorTgUserId) {
    const tgChatId = chain.tg_channel_id?.trim();
    if (!tgChatId) {
        throw new Error('chain has no telegram channel id');
    }
    let allowed = false;
    if (actorMaxUserId != null && (await (0, channelPostActions_1.isUserChannelAdmin)(bot, chain.max_chat_id, actorMaxUserId))) {
        allowed = true;
    }
    if (actorTgUserId != null) {
        const admins = await (0, integrationPlatformClient_1.listTelegramChatAdministrators)(tgToken, tgChatId);
        if (admins.some((a) => a.userId === actorTgUserId)) {
            allowed = true;
        }
    }
    if (!allowed) {
        throw new Error('forbidden');
    }
}
async function syncChannelLinkAdminTeam(bot, tgToken, input) {
    await (0, adminPanelState_1.ensureAdminPanelStateLoaded)();
    const chain = (await (0, adminPanelState_1.listTgChains)()).find((c) => c.id === input.chainId.trim());
    if (!chain) {
        throw new Error('chain not found');
    }
    const tgChatId = chain.tg_channel_id?.trim();
    if (!tgChatId) {
        throw new Error('chain has no telegram channel id');
    }
    const tgReg = telegramChannelRegistry_1.telegramChannelRegistry.getChannel(tgChatId);
    if (!tgReg?.bot_is_admin) {
        throw new Error('telegram bot is not admin');
    }
    await assertActorMaySyncChain(bot, tgToken, chain, input.actorMaxUserId, input.actorTgUserId);
    const maxRows = await listMaxChannelAdmins(bot, chain.max_chat_id);
    const tgApiRows = await (0, integrationPlatformClient_1.listTelegramChatAdministrators)(tgToken, tgChatId);
    const tgRows = tgApiRows.map((a) => ({
        platform: 'telegram',
        userId: a.userId,
        name: a.name,
        username: a.username ?? null,
    }));
    const byUsername = new Map();
    const maxOnly = [];
    const tgOnly = [];
    for (const row of maxRows) {
        const key = normUsername(row.username);
        if (!key) {
            maxOnly.push(row);
            continue;
        }
        const slot = byUsername.get(key) ?? {};
        slot.max = row;
        byUsername.set(key, slot);
    }
    for (const row of tgRows) {
        const key = normUsername(row.username);
        if (!key) {
            tgOnly.push(row);
            continue;
        }
        const slot = byUsername.get(key);
        if (slot?.max) {
            slot.tg = row;
            byUsername.set(key, slot);
        }
        else if (slot?.tg) {
            tgOnly.push(row);
        }
        else {
            byUsername.set(key, { tg: row });
        }
    }
    for (const [, slot] of byUsername) {
        if (slot.max && !slot.tg) {
            maxOnly.push(slot.max);
        }
        else if (slot.tg && !slot.max) {
            tgOnly.push(slot.tg);
        }
    }
    const members = [];
    let pairedCount = 0;
    const commitPair = (maxRow, tgRow, username) => {
        const profileId = ownerProfileStore_1.ownerProfileStore.syncAccount(toOwnerAccount(maxRow));
        ownerProfileStore_1.ownerProfileStore.attachAccountToProfile(profileId, toOwnerAccount(tgRow));
        channelNotifyLinkStore_1.channelNotifyLinkStore.register(maxRow.userId, chain.max_chat_id);
        telegramChannelNotifyLinkStore_1.telegramChannelNotifyLinkStore.register(tgRow.userId, tgChatId);
        settingsStore_1.settingsStore.linkUserToChannel(maxRow.userId, chain.max_chat_id);
        pairedCount += 1;
        members.push({
            profile_id: profileId,
            display_name: tgRow.name || maxRow.name,
            username,
            max_user_id: maxRow.userId,
            tg_user_id: tgRow.userId,
            paired: true,
        });
    };
    const pullMax = (row) => {
        const i = maxOnly.findIndex((r) => r.userId === row.userId);
        if (i >= 0) {
            maxOnly.splice(i, 1);
        }
    };
    const pullTg = (row) => {
        const i = tgOnly.findIndex((r) => r.userId === row.userId);
        if (i >= 0) {
            tgOnly.splice(i, 1);
        }
    };
    for (let i = maxOnly.length - 1; i >= 0; i -= 1) {
        const maxRow = maxOnly[i];
        const profileId = ownerProfileStore_1.ownerProfileStore.getProfileId('max', maxRow.userId);
        if (!profileId) {
            continue;
        }
        const tgAccount = ownerProfileStore_1.ownerProfileStore
            .getAccountsForProfile(profileId)
            .find((a) => a.platform === 'telegram');
        if (!tgAccount) {
            continue;
        }
        const tgUserId = Number.parseInt(tgAccount.platform_user_id, 10);
        if (!Number.isInteger(tgUserId) || tgUserId <= 0) {
            continue;
        }
        const tgRow = tgOnly.find((r) => r.userId === tgUserId);
        if (!tgRow) {
            continue;
        }
        commitPair(maxRow, tgRow, normUsername(tgRow.username) ?? normUsername(maxRow.username));
        pullMax(maxRow);
        pullTg(tgRow);
    }
    for (const [username, slot] of byUsername) {
        if (!slot.max || !slot.tg) {
            continue;
        }
        commitPair(slot.max, slot.tg, username);
    }
    for (const row of maxOnly) {
        const profileId = ownerProfileStore_1.ownerProfileStore.syncAccount(toOwnerAccount(row));
        channelNotifyLinkStore_1.channelNotifyLinkStore.register(row.userId, chain.max_chat_id);
        settingsStore_1.settingsStore.linkUserToChannel(row.userId, chain.max_chat_id);
        members.push({
            profile_id: profileId,
            display_name: row.name,
            username: row.username,
            max_user_id: row.userId,
            tg_user_id: null,
            paired: false,
        });
    }
    for (const row of tgOnly) {
        const profileId = ownerProfileStore_1.ownerProfileStore.syncAccount(toOwnerAccount(row));
        telegramChannelNotifyLinkStore_1.telegramChannelNotifyLinkStore.register(row.userId, tgChatId);
        members.push({
            profile_id: profileId,
            display_name: row.name,
            username: row.username,
            max_user_id: null,
            tg_user_id: row.userId,
            paired: false,
        });
    }
    members.sort((a, b) => a.display_name.localeCompare(b.display_name, 'ru'));
    const tgTitle = tgReg.title?.trim() || chain.tg_username || tgChatId;
    const maxTitle = chain.max_title?.trim() || null;
    logger_1.logger.info('channelLinkAdminTeamSync: done', {
        chainId: chain.id,
        pairedCount,
        maxOnly: maxOnly.length,
        tgOnly: tgOnly.length,
    });
    return {
        chain_id: chain.id,
        tg_title: tgTitle,
        max_title: maxTitle,
        paired_count: pairedCount,
        max_only_count: maxOnly.length,
        tg_only_count: tgOnly.length,
        members,
    };
}
async function syncAllChannelLinkAdminTeamsForUser(bot, tgToken, input) {
    const results = [];
    for (const chain of input.chains) {
        if (!chain.active || !chain.tg_channel_id?.trim()) {
            continue;
        }
        try {
            const row = await syncChannelLinkAdminTeam(bot, tgToken, {
                chainId: chain.id,
                actorMaxUserId: input.actorMaxUserId,
                actorTgUserId: input.actorTgUserId,
            });
            results.push(row);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger_1.logger.warn('syncAllChannelLinkAdminTeamsForUser: chain skipped', {
                chainId: chain.id,
                msg,
            });
        }
    }
    return results;
}
//# sourceMappingURL=channelLinkAdminTeamSync.js.map