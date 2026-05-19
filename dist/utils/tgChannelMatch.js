"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.telegramChannelMatchesTarget = telegramChannelMatchesTarget;
exports.normalizeTelegramChannelKey = normalizeTelegramChannelKey;
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
//# sourceMappingURL=tgChannelMatch.js.map