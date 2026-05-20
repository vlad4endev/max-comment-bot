"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractMemberAvatarUrl = extractMemberAvatarUrl;
exports.resolveMemberAvatarUrls = resolveMemberAvatarUrls;
exports.resolveMemberDisplayName = resolveMemberDisplayName;
const stateManager_1 = require("../services/stateManager");
const logger_1 = require("./logger");
const BATCH_SIZE = 50;
function extractMemberAvatarUrl(member) {
    if (!member) {
        return null;
    }
    const raw = member.full_avatar_url ?? member.avatar_url;
    if (typeof raw !== 'string') {
        return null;
    }
    const trimmed = raw.trim();
    return trimmed || null;
}
async function fetchMemberAvatarUrlsInChat(bot, chatId, userIds) {
    const out = new Map();
    const unique = [...new Set(userIds.filter((id) => id > 0))];
    if (unique.length === 0) {
        return out;
    }
    for (let i = 0; i < unique.length; i += BATCH_SIZE) {
        const chunk = unique.slice(i, i + BATCH_SIZE);
        try {
            const { members } = await bot.api.getChatMembers(chatId, { user_ids: chunk });
            for (const m of members) {
                const url = extractMemberAvatarUrl(m);
                if (url) {
                    out.set(m.user_id, url);
                }
            }
        }
        catch (err) {
            logger_1.logger.warn('fetchMemberAvatarUrlsInChat: getChatMembers failed', { chatId, err });
        }
    }
    return out;
}
/**
 * Resolves profile photo URLs for users via channel membership, then private dialog fallback.
 */
async function resolveMemberAvatarUrls(bot, channelChatId, userIds) {
    const out = await fetchMemberAvatarUrlsInChat(bot, channelChatId, userIds);
    const missing = [...new Set(userIds.filter((id) => id > 0 && !out.has(id)))];
    for (const userId of missing) {
        const priv = stateManager_1.stateManager.getUserPrivateChatId(userId);
        if (priv === undefined) {
            continue;
        }
        try {
            const { members } = await bot.api.getChatMembers(priv, { user_ids: [userId] });
            const url = extractMemberAvatarUrl(members[0]);
            if (url) {
                out.set(userId, url);
            }
        }
        catch (err) {
            logger_1.logger.debug('resolveMemberAvatarUrls: private getChatMembers failed', {
                userId,
                priv,
                err,
            });
        }
    }
    return out;
}
/**
 * Display name for a user (e.g. who replied as channel): `name` from channel membership,
 * then from remembered private dialog with the bot.
 */
async function resolveMemberDisplayName(bot, channelChatId, userId) {
    if (!Number.isFinite(userId) || userId <= 0) {
        return null;
    }
    try {
        const { members } = await bot.api.getChatMembers(channelChatId, { user_ids: [userId] });
        const n = members[0]?.name?.trim();
        if (n) {
            return n;
        }
    }
    catch (err) {
        logger_1.logger.debug('resolveMemberDisplayName: channel getChatMembers failed', {
            channelChatId,
            userId,
            err,
        });
    }
    const priv = stateManager_1.stateManager.getUserPrivateChatId(userId);
    if (priv !== undefined) {
        try {
            const { members } = await bot.api.getChatMembers(priv, { user_ids: [userId] });
            const n = members[0]?.name?.trim();
            if (n) {
                return n;
            }
        }
        catch (err) {
            logger_1.logger.debug('resolveMemberDisplayName: private getChatMembers failed', {
                priv,
                userId,
                err,
            });
        }
    }
    return null;
}
//# sourceMappingURL=memberAvatar.js.map