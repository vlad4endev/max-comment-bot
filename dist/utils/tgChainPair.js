"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tgChainMatchesPair = tgChainMatchesPair;
exports.findActiveTgChainForPair = findActiveTgChainForPair;
/** Та же пара MAX + TG, что и при создании цепочки в админ-панели. */
function tgChainMatchesPair(chain, maxChatId, tgChannelId, tgUsername) {
    if (chain.active === false) {
        return false;
    }
    if (chain.max_chat_id !== maxChatId) {
        return false;
    }
    const tgKey = (tgChannelId ?? '').trim();
    if (tgKey) {
        return (chain.tg_channel_id ?? '').trim() === tgKey;
    }
    const uname = tgUsername.trim().replace(/^@/, '').toLowerCase();
    return chain.tg_username.trim().replace(/^@/, '').toLowerCase() === uname;
}
function findActiveTgChainForPair(chains, maxChatId, tgChannelId, tgUsername) {
    return (chains.find((c) => tgChainMatchesPair(c, maxChatId, tgChannelId, tgUsername)) ?? null);
}
//# sourceMappingURL=tgChainPair.js.map