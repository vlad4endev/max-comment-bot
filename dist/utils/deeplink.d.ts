export interface ParsedPayload {
    type: string;
    id: string;
}
export declare function generateDeeplink(payload: string, botNickname?: string): string;
export declare function parsePayload(payload: string | null): ParsedPayload | null;
/** Opens bot chat (not Mini App) with admin invite payload `join<abs(channelChatId)>`. */
export declare function buildBotJoinUrl(channelChatId: number, botNickname?: string): string;
