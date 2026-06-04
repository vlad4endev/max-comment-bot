export interface ResolvedTgChainChannelFields {
    tg_channel_id: string;
    tg_username: string;
}
/** Нормализует @username / -100… / t.me/… в канонический chat_id для пересылки постов. */
export declare function resolveTgChainChannelFields(token: string, tgRaw: string): Promise<ResolvedTgChainChannelFields | null>;
/** Починка связок из админки: tg_channel_id, пустой bot_token. */
export declare function repairTgChainsForForwarding(): Promise<{
    tokenRepaired: number;
    channelIdRepaired: number;
}>;
