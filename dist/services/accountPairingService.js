"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TELEGRAM_PAIRING_BOT_USERNAME = void 0;
exports.getAccountPairingStatus = getAccountPairingStatus;
exports.createTelegramPairingInvite = createTelegramPairingInvite;
exports.createMaxPairingInvite = createMaxPairingInvite;
exports.completeAccountPairingFromTelegram = completeAccountPairingFromTelegram;
exports.completeAccountPairingFromMax = completeAccountPairingFromMax;
exports.isAccountPairStartPayload = isAccountPairStartPayload;
const node_crypto_1 = require("node:crypto");
const config_1 = require("../config");
const database_1 = require("../db/database");
const deeplink_1 = require("../utils/deeplink");
const telegramDeeplink_1 = require("../utils/telegramDeeplink");
const ownerProfileStore_1 = require("./ownerProfileStore");
const telegramBotUserStore_1 = require("./telegramBotUserStore");
const logger_1 = require("../utils/logger");
const PAIRING_TTL_MINUTES = 30;
const BOT_USERNAME = 'commentvmax_bot';
exports.TELEGRAM_PAIRING_BOT_USERNAME = BOT_USERNAME;
function generateToken() {
    return (0, node_crypto_1.randomBytes)(9).toString('base64url').slice(0, 12);
}
function pairingExpiresAt() {
    return new Date(Date.now() + PAIRING_TTL_MINUTES * 60_000).toISOString();
}
function accountDisplayName(username, firstName, lastName, userId) {
    const full = [firstName, lastName].filter(Boolean).join(' ').trim();
    if (full) {
        return full;
    }
    if (username) {
        return username.startsWith('@') ? username : `@${username}`;
    }
    return `ID ${userId}`;
}
function getAccountPairingStatus(platform, userId) {
    const profileId = ownerProfileStore_1.ownerProfileStore.getProfileId(platform, userId);
    if (!profileId) {
        return {
            profile_id: null,
            max_linked: false,
            telegram_linked: false,
            max_account: null,
            telegram_account: null,
        };
    }
    const accounts = ownerProfileStore_1.ownerProfileStore.getAccountsForProfile(profileId);
    const maxAcc = accounts.find((a) => a.platform === 'max');
    const tgAcc = accounts.find((a) => a.platform === 'telegram');
    const maxUserId = maxAcc ? Number.parseInt(maxAcc.platform_user_id, 10) : Number.NaN;
    const tgUserId = tgAcc ? Number.parseInt(tgAcc.platform_user_id, 10) : Number.NaN;
    return {
        profile_id: profileId,
        max_linked: !!(maxAcc && Number.isInteger(maxUserId) && maxUserId > 0),
        telegram_linked: !!(tgAcc && Number.isInteger(tgUserId) && tgUserId > 0),
        max_account: maxAcc && Number.isInteger(maxUserId) && maxUserId > 0
            ? {
                user_id: maxUserId,
                username: maxAcc.username,
                name: accountDisplayName(maxAcc.username, maxAcc.first_name, maxAcc.last_name, maxUserId),
            }
            : null,
        telegram_account: tgAcc && Number.isInteger(tgUserId) && tgUserId > 0
            ? {
                user_id: tgUserId,
                username: tgAcc.username,
                name: accountDisplayName(tgAcc.username, tgAcc.first_name, tgAcc.last_name, tgUserId),
            }
            : null,
    };
}
function assertCanInvitePeer(platform, userId, target) {
    const status = getAccountPairingStatus(platform, userId);
    if (target === 'telegram' && status.telegram_linked) {
        throw new Error('telegram already linked');
    }
    if (target === 'max' && status.max_linked) {
        throw new Error('max already linked');
    }
}
function insertPendingToken(token, profileId, initiatorPlatform, initiatorUserId) {
    const expiresAt = pairingExpiresAt();
    (0, database_1.getDb)()
        .prepare(`INSERT INTO account_pairing_tokens (
        token, profile_id, initiator_platform, initiator_user_id, status, expires_at
      ) VALUES (?, ?, ?, ?, 'pending', ?)`)
        .run(token, profileId, initiatorPlatform, String(initiatorUserId), expiresAt);
    return expiresAt;
}
/** MAX-пользователь приглашает привязать Telegram. */
function createTelegramPairingInvite(account) {
    if (account.platform !== 'max') {
        throw new Error('invalid initiator platform');
    }
    assertCanInvitePeer('max', account.platformUserId, 'telegram');
    const profileId = ownerProfileStore_1.ownerProfileStore.syncAccount(account);
    const token = generateToken();
    const expiresAt = insertPendingToken(token, profileId, 'max', account.platformUserId);
    const payload = (0, telegramDeeplink_1.buildTelegramAccountPairStartPayload)(token);
    return {
        token,
        invite_url: (0, telegramDeeplink_1.buildTelegramBotPairUrl)(payload),
        expires_at: expiresAt,
        target_platform: 'telegram',
    };
}
/** Telegram-пользователь приглашает привязать MAX. */
function createMaxPairingInvite(account) {
    if (account.platform !== 'telegram') {
        throw new Error('invalid initiator platform');
    }
    assertCanInvitePeer('telegram', account.platformUserId, 'max');
    const profileId = ownerProfileStore_1.ownerProfileStore.syncAccount(account);
    const token = generateToken();
    const expiresAt = insertPendingToken(token, profileId, 'telegram', account.platformUserId);
    const payload = `pair_${token}`;
    const nick = config_1.config.botNickname.trim() || 'commentvmax_bot';
    return {
        token,
        invite_url: (0, deeplink_1.generateDeeplink)(payload, nick),
        expires_at: expiresAt,
        target_platform: 'max',
    };
}
function loadPendingToken(rawPayload) {
    const token = (0, telegramDeeplink_1.parseTelegramAccountPairToken)(rawPayload);
    if (!token) {
        throw new Error('invalid pairing token');
    }
    const row = (0, database_1.getDb)()
        .prepare(`SELECT token, profile_id, initiator_platform, initiator_user_id, status, expires_at
       FROM account_pairing_tokens WHERE token = ?`)
        .get(token);
    if (!row) {
        throw new Error('pairing token not found');
    }
    if (row.status === 'completed') {
        throw new Error('pairing token already used');
    }
    const expiresMs = Date.parse(row.expires_at);
    if (row.status === 'expired' || (Number.isFinite(expiresMs) && expiresMs < Date.now())) {
        (0, database_1.getDb)()
            .prepare(`UPDATE account_pairing_tokens SET status = 'expired' WHERE token = ?`)
            .run(token);
        throw new Error('pairing token expired');
    }
    if (row.initiator_platform !== 'max') {
        throw new Error('pairing token not for telegram completion');
    }
    return row;
}
function loadPendingTokenForMax(rawPayload) {
    const trimmed = String(rawPayload || '').trim();
    const m = /^pair_([A-Za-z0-9_-]{8,24})$/i.exec(trimmed);
    const token = m?.[1];
    if (!token) {
        throw new Error('invalid pairing token');
    }
    const row = (0, database_1.getDb)()
        .prepare(`SELECT token, profile_id, initiator_platform, initiator_user_id, status, expires_at
       FROM account_pairing_tokens WHERE token = ?`)
        .get(token);
    if (!row) {
        throw new Error('pairing token not found');
    }
    if (row.status === 'completed') {
        throw new Error('pairing token already used');
    }
    const expiresMs = Date.parse(row.expires_at);
    if (row.status === 'expired' || (Number.isFinite(expiresMs) && expiresMs < Date.now())) {
        (0, database_1.getDb)()
            .prepare(`UPDATE account_pairing_tokens SET status = 'expired' WHERE token = ?`)
            .run(token);
        throw new Error('pairing token expired');
    }
    if (row.initiator_platform !== 'telegram') {
        throw new Error('pairing token not for max completion');
    }
    return row;
}
function markTokenCompleted(token) {
    (0, database_1.getDb)()
        .prepare(`UPDATE account_pairing_tokens
       SET status = 'completed', completed_at = datetime('now')
       WHERE token = ?`)
        .run(token);
}
function completeAccountPairingFromTelegram(startPayload, telegramAccount) {
    if (telegramAccount.platform !== 'telegram') {
        throw new Error('invalid telegram account');
    }
    const row = loadPendingToken(startPayload);
    const initiatorMaxId = Number.parseInt(row.initiator_user_id, 10);
    ownerProfileStore_1.ownerProfileStore.attachAccountToProfile(row.profile_id, telegramAccount);
    telegramBotUserStore_1.telegramBotUserStore.markStarted({ id: telegramAccount.platformUserId });
    markTokenCompleted(row.token);
    logger_1.logger.info('accountPairing: telegram linked to max profile', {
        profileId: row.profile_id,
        tgUserId: telegramAccount.platformUserId,
        maxUserId: initiatorMaxId,
    });
    return {
        profile_id: row.profile_id,
        max_user_id: Number.isInteger(initiatorMaxId) && initiatorMaxId > 0 ? initiatorMaxId : null,
    };
}
function completeAccountPairingFromMax(startPayload, maxAccount) {
    if (maxAccount.platform !== 'max') {
        throw new Error('invalid max account');
    }
    const row = loadPendingTokenForMax(startPayload);
    const initiatorTgId = Number.parseInt(row.initiator_user_id, 10);
    ownerProfileStore_1.ownerProfileStore.attachAccountToProfile(row.profile_id, maxAccount);
    markTokenCompleted(row.token);
    logger_1.logger.info('accountPairing: max linked to telegram profile', {
        profileId: row.profile_id,
        maxUserId: maxAccount.platformUserId,
        tgUserId: initiatorTgId,
    });
    return {
        profile_id: row.profile_id,
        tg_user_id: Number.isInteger(initiatorTgId) && initiatorTgId > 0 ? initiatorTgId : null,
    };
}
function isAccountPairStartPayload(raw) {
    return (0, telegramDeeplink_1.isTelegramAccountPairStartPayload)(raw) || /^pair_[A-Za-z0-9_-]{8,24}$/i.test(String(raw || '').trim());
}
//# sourceMappingURL=accountPairingService.js.map