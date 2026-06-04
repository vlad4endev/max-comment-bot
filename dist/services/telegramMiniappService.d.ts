import type { Bot } from '@maxhub/max-bot-api';
export interface TelegramMiniappChannelWire {
    chat_id: string;
    title: string | null;
    subscribers: number | null;
    avatar_url: string | null;
    status: 'pending' | 'active';
    platform: 'telegram';
}
export declare function sendTelegramHowItWorksMessage(token: string, telegramUserId: number): Promise<void>;
export declare function handleTelegramBotStartWelcome(telegramUserId: number, from?: Record<string, unknown>): Promise<void>;
/** Ручное добавление канала по @username или -100… (если бот уже админ, но канал не в списке). */
export declare function registerTelegramChannelByKeyForMiniappUser(telegramUserId: number, channelKeyRaw: string): Promise<TelegramMiniappChannelWire>;
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
        paired: boolean;
        max_user_id: number | null;
        tg_user_id: number | null;
        peer_platform: 'max' | 'telegram' | null;
    }>;
    invite_url: string;
}>;
export declare function resolveTelegramChannelInviteAccess(telegramUserId: number, joinChannelIdRaw: string): Promise<{
    ok: true;
    channelChatId: string;
    title: string | null;
} | {
    ok: false;
    status: 400 | 403 | 404;
    error: string;
}>;
export declare function registerTelegramChannelNotifyLink(telegramUserId: number, channelChatId: string): Promise<{
    channel_title: string | null;
    already_linked: boolean;
}>;
/** Личные сообщения в Telegram-боте после успешной связки TG ↔ MAX. */
export declare function notifyChannelLinkSucceededPrivate(params: {
    profileId: string;
    maxUserId: number;
    maxTitle: string | null;
    tgTitle: string;
    confirmedByTgUserId: number;
}): Promise<void>;
export declare function handleTelegramBotAccountPair(telegramUserId: number, from: Record<string, unknown>, startPayload: string): Promise<void>;
export declare function handleTelegramBotStartJoin(telegramUserId: number, startPayload: string): Promise<void>;
export declare function processTelegramMiniappBotUpdates(token: string, updates: Array<Record<string, unknown>>, bot?: Bot | null): Promise<void>;
