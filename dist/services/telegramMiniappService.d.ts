export interface TelegramMiniappChannelWire {
    chat_id: string;
    title: string | null;
    subscribers: number | null;
    avatar_url: string | null;
    status: 'pending' | 'active';
    platform: 'telegram';
}
export declare function listTelegramMiniappChannelsForUser(telegramUserId: number): Promise<{
    channels: TelegramMiniappChannelWire[];
    bot_username: string;
}>;
export declare function getTelegramMiniappStats(telegramUserId: number): Promise<{
    channels: number;
    posts: number;
    comments: number;
    bot_nickname: string;
}>;
export declare function getTelegramChannelAdminsForMiniapp(telegramUserId: number, channelChatId: string): Promise<{
    admins: Array<{
        user_id: number;
        name: string;
        initials: string;
        linked: boolean;
    }>;
    invite_url: string;
}>;
export declare function resolveTelegramChannelInviteAccess(telegramUserId: number, joinChannelIdRaw: string): Promise<{
    ok: true;
    channelChatId: string;
    title: string | null;
} | {
    ok: false;
    status: 400 | 404;
    error: string;
}>;
export declare function registerTelegramChannelNotifyLink(telegramUserId: number, channelChatId: string): Promise<{
    channel_title: string | null;
    already_linked: boolean;
}>;
export declare function notifyTelegramChannelJoined(channelChatId: string): Promise<void>;
export declare function postTelegramChannelAdminInvite(channelChatId: string): Promise<void>;
export declare function handleTelegramBotStartJoin(telegramUserId: number, startPayload: string): Promise<void>;
export declare function handleTelegramMyChatMemberUpdate(update: Record<string, unknown>): Promise<void>;
export declare function processTelegramMiniappBotUpdates(token: string, updates: Array<Record<string, unknown>>): Promise<void>;
