"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveChannelChatIdFromInviteParam = resolveChannelChatIdFromInviteParam;
exports.resolveCanonicalChannelChatId = resolveCanonicalChannelChatId;
const channelRegistry_1 = require("./channelRegistry");
function resolveChannelChatIdFromAbsId(absId) {
    if (!Number.isFinite(absId) || absId <= 0) {
        return null;
    }
    const found = channelRegistry_1.channelRegistry.getAllChannels().find((c) => Math.abs(c.chat_id) === absId);
    if (found) {
        return found.chat_id;
    }
    return Number(`-${absId}`);
}
/**
 * Resolves `join{digits}`, a signed chat id, or an abs id string to the canonical channel `chat_id`
 * stored in {@link channelRegistry} (needed when invite links use `Math.abs(chat_id)` only).
 */
function resolveChannelChatIdFromInviteParam(raw) {
    const trimmed = raw.trim();
    if (trimmed === '') {
        return null;
    }
    const joinMatch = /^join(\d+)$/i.exec(trimmed);
    if (joinMatch) {
        return resolveChannelChatIdFromAbsId(Number.parseInt(joinMatch[1], 10));
    }
    const asInt = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(asInt) || asInt === 0) {
        return null;
    }
    const registered = channelRegistry_1.channelRegistry.getChannel(asInt);
    if (registered) {
        return registered.chat_id;
    }
    return resolveChannelChatIdFromAbsId(Math.abs(asInt));
}
/** Canonical negative `chat_id` from registry (matches invite links that only carry `abs(id)`). */
function resolveCanonicalChannelChatId(chatId) {
    if (!Number.isInteger(chatId) || chatId === 0) {
        return null;
    }
    const registered = channelRegistry_1.channelRegistry.getChannel(chatId);
    if (registered) {
        return registered.chat_id;
    }
    const abs = Math.abs(chatId);
    const found = channelRegistry_1.channelRegistry.getAllChannels().find((c) => Math.abs(c.chat_id) === abs);
    return found?.chat_id ?? chatId;
}
//# sourceMappingURL=resolveChannelChatId.js.map