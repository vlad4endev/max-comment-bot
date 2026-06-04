import type { TgChainRecord } from '../api/adminPanelState';
export interface TgChatRef {
    id: number;
    username?: string;
}
/**
 * Строгое сопоставление апдейта с выбранным TG-каналом (@username или -100… id).
 */
export declare function telegramChannelMatchesTarget(chat: TgChatRef, channelKey: string): boolean;
export declare function normalizeTelegramChannelKey(raw: string): string;
/** Все ключи TG-канала из связки (id, @username) для сопоставления с channel_post. */
export declare function collectTgChainChannelMatchKeys(chain: TgChainRecord): string[];
export declare function telegramMessageMatchesTgChain(chat: TgChatRef, chain: TgChainRecord): boolean;
