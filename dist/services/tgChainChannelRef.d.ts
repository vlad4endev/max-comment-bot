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
/** Заполняет forward_posts_since для старых связок (защита от пересылки архива getUpdates). */
export declare function repairTgChainForwardPostsSince(): Promise<number>;
/** После смены токена в интеграциях — обновить цепочки со старым или пустым bot_token. */
export declare function syncTgChainBotTokensOnTelegramReconnect(previousToken: string, newToken: string): Promise<number>;
/** Заменить в цепочках устаревшие bot_token, если основной токен валиден. */
export declare function repairStaleTgChainBotTokens(): Promise<{
    repaired: number;
    checked: number;
}>;
/** Включает forward_comments у старых miniapp-цепочек, где синхронизация была выключена по умолчанию. */
export declare function repairMiniappChainsForwardComments(): Promise<number>;
