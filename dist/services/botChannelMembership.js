"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchBotChatMember = fetchBotChatMember;
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
/** Whether the bot is allowed to moderate the channel (admin or owner). */
function isBotAdminOrOwner(member) {
    return member.is_admin || member.is_owner;
}
//# sourceMappingURL=botChannelMembership.js.map