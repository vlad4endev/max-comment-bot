/**
 * Классификация ошибок Telegram Bot API и MTProto для синхронизации комментариев.
 */
export declare function extractTelegramErrorText(err: unknown): string;
export declare function isInvalidTelegramMessageIdError(text: string): boolean;
export declare function isSendAsPeerInvalidError(text: string): boolean;
export declare function isTelegramUnauthorizedError(text: string): boolean;
export declare function isTelegramForbiddenError(text: string): boolean;
export declare function suggestActionForTelegramSyncError(text: string): string;
