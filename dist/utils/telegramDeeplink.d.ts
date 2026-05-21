/** Telegram bot deep link: `?start=jointg{chatId without minus}`. */
export declare function buildTelegramBotJoinUrl(telegramChatId: string, botUsername?: string): string;
/** Parses `jointg1001234567890` → `-1001234567890`. */
export declare function resolveTelegramChatIdFromJoinPayload(raw: string): string | null;
export declare function isTelegramJoinStartPayload(raw: string): boolean;
/** Inline callback: подтвердить подключение TG-канала (аналог MAX `confirm_ch_`). */
export declare function buildTelegramConfirmChannelPayload(telegramChatId: string): string;
export declare function parseTelegramConfirmChannelPayload(raw: string): string | null;
export declare function chatIdToConnectArg(telegramChatId: string): string;
export declare function parseTelegramConnectCommand(text: string): false | {
    mode: 'all';
} | {
    mode: 'one';
    channelChatId: string;
} | undefined;
