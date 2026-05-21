"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listTgChainsForMaxChannel = listTgChainsForMaxChannel;
exports.isCommentsButtonEnabledForMaxChannel = isCommentsButtonEnabledForMaxChannel;
const adminPanelState_1 = require("../api/adminPanelState");
const resolveChannelChatId_1 = require("./resolveChannelChatId");
function maxChannelAbs(chatId) {
    const canonical = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(chatId) ?? chatId;
    return Math.abs(canonical);
}
/** Active TG→MAX chains that target this MAX channel. */
function listTgChainsForMaxChannel(chatId) {
    const abs = maxChannelAbs(chatId);
    return (0, adminPanelState_1.listTgChainsSync)().filter((c) => c.active !== false && Math.abs(c.max_chat_id) === abs);
}
/**
 * Whether the bot may attach the «Комментарии» Mini App button for this MAX channel.
 *
 * - Channel is **not** a TG chain destination → enabled (native MAX / registry only).
 * - Channel is a chain destination → follows `add_comments_button` on **every** active chain row.
 * - `/addbutton` (`source: manual`) bypasses this check in {@link tryAttachCommentsToChannelPost}.
 */
function isCommentsButtonEnabledForMaxChannel(chatId) {
    const chains = listTgChainsForMaxChannel(chatId);
    if (chains.length === 0) {
        return true;
    }
    return chains.every((c) => c.add_comments_button !== false);
}
//# sourceMappingURL=channelCommentsButtonPolicy.js.map