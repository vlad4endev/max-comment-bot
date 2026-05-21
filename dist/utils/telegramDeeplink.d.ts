/** Telegram bot deep link: `?start=jointg{chatId without minus}`. */
export declare function buildTelegramBotJoinUrl(telegramChatId: string, botUsername?: string): string;
/** Parses `jointg1001234567890` → `-1001234567890`. */
export declare function resolveTelegramChatIdFromJoinPayload(raw: string): string | null;
export declare function isTelegramJoinStartPayload(raw: string): boolean;
/** Inline callback: подтвердить подключение TG-канала (аналог MAX `confirm_ch_`). */
export declare function buildTelegramConfirmChannelPayload(telegramChatId: string): string;
export declare function parseTelegramConfirmChannelPayload(raw: string): string | null;
export declare function chatIdToConnectArg(telegramChatId: string): string;
/** Deep link: привязка аккаунта Telegram к профилю MAX `?start=pair_<token>`. */
export declare function buildTelegramAccountPairStartPayload(token: string): string;
export declare function parseTelegramAccountPairToken(raw: string): string | null;
export declare function isTelegramAccountPairStartPayload(raw: string): boolean;
export declare function buildTelegramBotPairUrl(startPayload: string, botUsername?: string): string;
export declare function parseTelegramConnectCommand(text: string): false | {
    mode: 'all';
} | {
    mode: 'one';
    channelChatId: string;
} | undefined;
