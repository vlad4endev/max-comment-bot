"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolvePrimaryTelegramChannelChatIdForMax = resolvePrimaryTelegramChannelChatIdForMax;
exports.buildTelegramNotifyInviteUrlForMaxChannel = buildTelegramNotifyInviteUrlForMaxChannel;
exports.listSupplementalTelegramAdminsForMaxChannel = listSupplementalTelegramAdminsForMaxChannel;
const adminPanelState_1 = require("../api/adminPanelState");
const telegramDeeplink_1 = require("../utils/telegramDeeplink");
const channelCommentsButtonPolicy_1 = require("./channelCommentsButtonPolicy");
const channelLinkAdminTeamSync_1 = require("./channelLinkAdminTeamSync");
const integrationsStore_1 = require("./integrationsStore");
const integrationPlatformClient_1 = require("./integrationPlatformClient");
const telegramAdminNotificationService_1 = require("./telegramAdminNotificationService");
const telegramBotUserStore_1 = require("./telegramBotUserStore");
const telegramChannelNotifyLinkStore_1 = require("./telegramChannelNotifyLinkStore");
function adminDisplayInitials(name) {
    const t = name.trim();
    if (t.length >= 2) {
        const parts = t.split(/\s+/);
        if (parts.length >= 2) {
            return (parts[0][0] + parts[1][0]).toUpperCase();
        }
        return t.slice(0, 2).toUpperCase();
    }
    return t.slice(0, 2).toUpperCase() || '?';
}
/** Numeric Telegram chat id linked to this MAX channel (tg_chain or integration flow). */
function resolvePrimaryTelegramChannelChatIdForMax(maxChatId) {
    for (const chain of (0, channelCommentsButtonPolicy_1.listTgChainsForMaxChannel)(maxChatId)) {
        const id = chain.tg_channel_id?.trim();
        if (id && /^-?\d+$/.test(id)) {
            return id;
        }
    }
    for (const source of (0, telegramAdminNotificationService_1.resolveTelegramSourceChannelsForMaxChat)(maxChatId)) {
        const t = source.trim();
        if (/^-?\d+$/.test(t)) {
            return t;
        }
    }
    return null;
}
/** `jointg…` deep link for TG-only admins of the linked Telegram channel. */
function buildTelegramNotifyInviteUrlForMaxChannel(maxChatId) {
    const tgChatId = resolvePrimaryTelegramChannelChatIdForMax(maxChatId);
    if (!tgChatId) {
        return null;
    }
    try {
        return (0, telegramDeeplink_1.buildTelegramBotJoinUrl)(tgChatId);
    }
    catch {
        return null;
    }
}
/**
 * TG channel admins who are not represented as MAX channel admins (colleagues only in Telegram).
 */
async function listSupplementalTelegramAdminsForMaxChannel(maxChatId, maxAdminUserIds, tgToken) {
    await (0, adminPanelState_1.ensureAdminPanelStateLoaded)();
    await integrationsStore_1.integrationsStore.load();
    const tgChatId = resolvePrimaryTelegramChannelChatIdForMax(maxChatId);
    const token = tgToken.trim();
    if (!tgChatId || token === '') {
        return { tgChannelChatId: null, admins: [] };
    }
    let tgAdmins;
    try {
        tgAdmins = await (0, integrationPlatformClient_1.listTelegramChatAdministrators)(token, tgChatId);
    }
    catch {
        return { tgChannelChatId: tgChatId, admins: [] };
    }
    const linkedIds = new Set(telegramChannelNotifyLinkStore_1.telegramChannelNotifyLinkStore.getUserIdsForChannel(tgChatId));
    const startedIds = telegramBotUserStore_1.telegramBotUserStore.getStartedIds(tgAdmins.map((a) => a.userId));
    const supplemental = [];
    const seen = new Set();
    for (const row of tgAdmins) {
        if (seen.has(row.userId)) {
            continue;
        }
        seen.add(row.userId);
        const pairing = (0, channelLinkAdminTeamSync_1.profilePairingForPlatformUser)('telegram', row.userId);
        if (pairing.max_user_id != null && maxAdminUserIds.has(pairing.max_user_id)) {
            continue;
        }
        supplemental.push({
            user_id: row.userId,
            name: row.name,
            initials: adminDisplayInitials(row.name),
            linked: linkedIds.has(row.userId) && startedIds.has(row.userId),
            paired: false,
            max_user_id: null,
            tg_user_id: row.userId,
            peer_platform: 'telegram',
            admin_platform: 'telegram',
        });
    }
    return { tgChannelChatId: tgChatId, admins: supplemental };
}
//# sourceMappingURL=maxChannelTelegramAdminInvite.js.map