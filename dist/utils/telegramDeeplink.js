"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTelegramBotJoinUrl = buildTelegramBotJoinUrl;
exports.resolveTelegramChatIdFromJoinPayload = resolveTelegramChatIdFromJoinPayload;
exports.isTelegramJoinStartPayload = isTelegramJoinStartPayload;
exports.buildTelegramConfirmChannelPayload = buildTelegramConfirmChannelPayload;
exports.parseTelegramConfirmChannelPayload = parseTelegramConfirmChannelPayload;
exports.chatIdToConnectArg = chatIdToConnectArg;
exports.parseTelegramConnectCommand = parseTelegramConnectCommand;
/** Telegram bot deep link: `?start=jointg{chatId without minus}`. */
function buildTelegramBotJoinUrl(telegramChatId, botUsername = 'commentvmax_bot') {
    const nick = botUsername.replace(/^@/, '').trim();
    const id = String(telegramChatId).trim().replace(/^-/, '');
    if (!/^\d+$/.test(id)) {
        throw new Error('buildTelegramBotJoinUrl: invalid telegram chat id');
    }
    return `https://t.me/${nick}?start=jointg${id}`;
}
/** Parses `jointg1001234567890` → `-1001234567890`. */
function resolveTelegramChatIdFromJoinPayload(raw) {
    const trimmed = String(raw || '').trim();
    const m = /^jointg(\d+)$/i.exec(trimmed);
    if (!m) {
        return null;
    }
    return `-${m[1]}`;
}
function isTelegramJoinStartPayload(raw) {
    return /^jointg\d+$/i.test(String(raw || '').trim());
}
/** Inline callback: подтвердить подключение TG-канала (аналог MAX `confirm_ch_`). */
function buildTelegramConfirmChannelPayload(telegramChatId) {
    const digits = String(telegramChatId).trim().replace(/^-/, '');
    if (!/^\d+$/.test(digits)) {
        throw new Error('buildTelegramConfirmChannelPayload: invalid telegram chat id');
    }
    return `confirm_tg_ch_${digits}`;
}
function parseTelegramConfirmChannelPayload(raw) {
    const m = /^confirm_tg_ch_(\d+)$/i.exec(String(raw || '').trim());
    if (!m) {
        return null;
    }
    return `-${m[1]}`;
}
function chatIdToConnectArg(telegramChatId) {
    return String(telegramChatId).trim().replace(/^-/, '');
}
function parseTelegramConnectCommand(text) {
    const t = text.trim();
    if (!/^\/connect\b/i.test(t)) {
        return false;
    }
    const rest = t.replace(/^\/connect\b/i, '').trim();
    if (rest === '') {
        return { mode: 'all' };
    }
    const normalized = rest.startsWith('-') ? rest : `-${rest.replace(/\D/g, '')}`;
    if (!/^-\d+$/.test(normalized)) {
        return undefined;
    }
    return { mode: 'one', channelChatId: normalized };
}
//# sourceMappingURL=telegramDeeplink.js.map