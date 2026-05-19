export interface TgChatRef {
    id: number;
    username?: string;
}
/**
 * Строгое сопоставление апдейта с выбранным TG-каналом (@username или -100… id).
 */
export declare function telegramChannelMatchesTarget(chat: TgChatRef, channelKey: string): boolean;
export declare function normalizeTelegramChannelKey(raw: string): string;
