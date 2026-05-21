"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listTgChainsForMaxChannel = listTgChainsForMaxChannel;
exports.isCommentsButtonEnabledForTgChainForward = isCommentsButtonEnabledForTgChainForward;
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
 * Whether TG→MAX **forward** may attach the «Комментарии» button (`source: tg_chain` only).
 *
 * Native MAX posts (webhook/poller/refresh) ignore this — they use the default attach flow even if
 * the same `max_chat_id` is also a chain destination with the toggle off.
 */
function isCommentsButtonEnabledForTgChainForward(chatId) {
    const chains = listTgChainsForMaxChannel(chatId);
    if (chains.length === 0) {
        return true;
    }
    return chains.every((c) => c.add_comments_button !== false);
}
//# sourceMappingURL=channelCommentsButtonPolicy.js.map