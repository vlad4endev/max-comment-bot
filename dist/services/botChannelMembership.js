"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchBotChatMember = fetchBotChatMember;
exports.fetchBotChatMemberWithRetry = fetchBotChatMemberWithRetry;
exports.isBotAdminOrOwner = isBotAdminOrOwner;
const logger_1 = require("../utils/logger");
/**
 * Loads the bot's own {@link ChatMember} row in a chat via `GET chats/{id}/members/me`.
 */
async function fetchBotChatMember(bot, channelChatId) {
    try {
        return await bot.api.getChatMembership(channelChatId);
    }
    catch (err) {
        logger_1.logger.warn('fetchBotChatMember: API error', { channelChatId, err });
        return null;
    }
}
/** Повтор при задержке MAX API сразу после добавления бота в канал. */
async function fetchBotChatMemberWithRetry(bot, channelChatId, attempts = 3, delayMs = 1200) {
    for (let i = 0; i < attempts; i++) {
        const member = await fetchBotChatMember(bot, channelChatId);
        if (member) {
            return member;
        }
        if (i < attempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
    return null;
}
/** Whether the bot is allowed to moderate the channel (admin or owner). */
function isBotAdminOrOwner(member) {
    return member.is_admin || member.is_owner;
}
//# sourceMappingURL=botChannelMembership.js.map