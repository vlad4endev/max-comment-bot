export declare function buildTelegramMiniappAuth(telegramUserId: number, maxChatId: number): {
    tg_uid: string;
    tg_exp: string;
    tg_sig: string;
};
export declare function verifyTelegramMiniappAuth(input: {
    telegramUserId: number;
    maxChatId: number;
    tgUidRaw: string | null | undefined;
    tgExpRaw: string | null | undefined;
    tgSigRaw: string | null | undefined;
}): boolean;
export declare function buildTelegramMiniappUrl(input: {
    postId: string;
    maxChatId: number;
    messageMid?: string;
    telegramUserId: number;
}): string | null;
