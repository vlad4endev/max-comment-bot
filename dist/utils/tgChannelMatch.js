"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.telegramChannelMatchesTarget = telegramChannelMatchesTarget;
exports.normalizeTelegramChannelKey = normalizeTelegramChannelKey;
exports.collectTgChainChannelMatchKeys = collectTgChainChannelMatchKeys;
exports.telegramMessageMatchesTgChain = telegramMessageMatchesTgChain;
/**
 * Строгое сопоставление апдейта с выбранным TG-каналом (@username или -100… id).
 */
function telegramChannelMatchesTarget(chat, channelKey) {
    const raw = channelKey.trim();
    if (!raw)
        return false;
    const targetId = raw.replace(/^@/, '');
    const chatKey = typeof chat.username === 'string' && chat.username.trim() !== ''
        ? chat.username.trim().toLowerCase()
        : String(chat.id);
    if (targetId.startsWith('-') || /^\d+$/.test(targetId)) {
        return String(chat.id) === targetId;
    }
    return chatKey === targetId.toLowerCase();
}
function normalizeTelegramChannelKey(raw) {
    const t = raw.trim();
    if (!t)
        return t;
    if (/^-?\d+$/.test(t))
        return t;
    return t.startsWith('@') ? t : `@${t}`;
}
/** Все ключи TG-канала из связки (id, @username) для сопоставления с channel_post. */
function collectTgChainChannelMatchKeys(chain) {
    const keys = new Set();
    const id = chain.tg_channel_id?.trim() ?? '';
    if (id) {
        keys.add(id);
    }
    const uname = chain.tg_username?.trim().replace(/^@/, '') ?? '';
    if (uname) {
        keys.add(`@${uname}`);
        keys.add(uname);
    }
    return [...keys];
}
function telegramMessageMatchesTgChain(chat, chain) {
    const keys = collectTgChainChannelMatchKeys(chain);
    if (keys.length === 0) {
        return false;
    }
    return keys.some((key) => telegramChannelMatchesTarget(chat, key));
}
//# sourceMappingURL=tgChannelMatch.js.map