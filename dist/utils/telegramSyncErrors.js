"use strict";
/**
 * Классификация ошибок Telegram Bot API и MTProto для синхронизации комментариев.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractTelegramErrorText = extractTelegramErrorText;
exports.isInvalidTelegramMessageIdError = isInvalidTelegramMessageIdError;
exports.isSendAsPeerInvalidError = isSendAsPeerInvalidError;
exports.isTelegramUnauthorizedError = isTelegramUnauthorizedError;
exports.isTelegramForbiddenError = isTelegramForbiddenError;
exports.suggestActionForTelegramSyncError = suggestActionForTelegramSyncError;
function extractTelegramErrorText(err) {
    if (err instanceof Error && err.message.trim()) {
        return err.message.trim();
    }
    if (typeof err === 'object' && err !== null) {
        if ('errorMessage' in err) {
            const rpc = String(err.errorMessage || '').trim();
            if (rpc) {
                return rpc;
            }
        }
        if ('description' in err) {
            const description = String(err.description || '').trim();
            if (description) {
                return description;
            }
        }
    }
    return String(err ?? '');
}
function isInvalidTelegramMessageIdError(text) {
    const normalized = text.toUpperCase();
    return (normalized.includes('MSG_ID_INVALID') ||
        normalized.includes('MESSAGE_ID_INVALID') ||
        normalized.includes('MESSAGE TO REPLY NOT FOUND') ||
        normalized.includes('MESSAGE THREAD NOT FOUND') ||
        normalized.includes('REPLY MESSAGE NOT FOUND') ||
        normalized.includes('MESSAGE NOT FOUND'));
}
function isSendAsPeerInvalidError(text) {
    const normalized = text.toUpperCase();
    return (normalized.includes('SEND_AS_PEER_INVALID') ||
        normalized.includes('PEER_ID_INVALID') ||
        normalized.includes('USER_BANNED_IN_CHANNEL'));
}
function isTelegramUnauthorizedError(text) {
    const normalized = text.toUpperCase();
    return (normalized.includes('UNAUTHORIZED') ||
        normalized.includes('401') ||
        normalized.includes('WRONG REMOTE ID') ||
        normalized.includes('TOKEN IS INVALID') ||
        normalized.includes('BOT TOKEN'));
}
function isTelegramForbiddenError(text) {
    const normalized = text.toUpperCase();
    if (isTelegramUnauthorizedError(normalized)) {
        return false;
    }
    return (normalized.includes('FORBIDDEN') ||
        normalized.includes('BOT WAS BLOCKED') ||
        normalized.includes('BOT IS NOT A MEMBER') ||
        normalized.includes('CHAT_WRITE_FORBIDDEN') ||
        normalized.includes('NOT ENOUGH RIGHTS') ||
        normalized.includes('403'));
}
function suggestActionForTelegramSyncError(text) {
    if (isTelegramUnauthorizedError(text)) {
        return 'Токен Telegram бота недействителен. Обновите TG_TOKEN в интеграциях или @BotFather и перезапустите сервис.';
    }
    if (isInvalidTelegramMessageIdError(text)) {
        return 'Проверьте, что у поста в канале есть связанный тред в группе обсуждений. Запустите repair-threads в админке.';
    }
    if (isSendAsPeerInvalidError(text)) {
        return 'Бот/сессия не может писать от имени канала. Проверьте права администратора или переключите tg_discussion_send_as на chat.';
    }
    if (isTelegramForbiddenError(text)) {
        return 'Проверьте токен бота и добавьте бота в канал и группу обсуждений с правами администратора.';
    }
    return 'Проверьте логи и настройки цепочки TG→MAX.';
}
//# sourceMappingURL=telegramSyncErrors.js.map