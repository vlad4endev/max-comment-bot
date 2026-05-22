import type { Bot } from '@maxhub/max-bot-api';
import { type OwnerAccountInput } from './ownerProfileStore';
export interface ChannelLinkWire {
    id: string;
    tg_title: string;
    tg_username: string;
    tg_channel_id: string | null;
    max_chat_id: number;
    max_title: string | null;
    active: boolean;
    forward_posts: boolean;
    add_comments_button: boolean;
    forwarded_today: number;
    created_at: string;
}
export declare function syncOwnerProfileFromMiniapp(platform: 'max' | 'telegram', account: OwnerAccountInput): Promise<{
    profile_id: string;
}>;
export declare function createChannelLinkDraft(bot: Bot, input: {
    maxUserId: number;
    maxChatId: number;
    account: OwnerAccountInput;
}): Promise<{
    code: string;
    expires_at: string;
    max_title: string | null;
    profile_id: string;
}>;
export declare function getChannelLinkDraftPreview(code: string): {
    max_title: string | null;
    tg_title: string | null;
    expires_at: string;
    status: string;
} | null;
/** Шаг 1 (Telegram): указать канал и код — ждёт подтверждения в MAX. */
export declare function submitChannelLinkDraftFromTelegram(tgToken: string, input: {
    code: string;
    tgUserId: number;
    tgChannelId: string;
    account: OwnerAccountInput;
    forwardPosts?: boolean;
    addCommentsButton?: boolean;
}, options?: {
    maxBot?: Bot;
}): Promise<{
    status: 'awaiting_max_confirm';
    profile_id: string;
    max_title: string | null;
    tg_title: string;
}>;
/** Шаг 2 (MAX): кнопка «Подтвердить связку» — создаёт цепочку TG → MAX. */
export declare function finalizeChannelLinkDraftInMax(bot: Bot, code: string, maxUserId: number): Promise<{
    chain: ChannelLinkWire;
    profile_id: string;
}>;
/** @deprecated Use submit + finalize; kept for route name compatibility. */
export declare function confirmChannelLinkDraft(tgToken: string, input: {
    code: string;
    tgUserId: number;
    tgChannelId: string;
    account: OwnerAccountInput;
    forwardPosts?: boolean;
    addCommentsButton?: boolean;
}, options?: {
    maxBot?: Bot;
}): Promise<{
    status: 'awaiting_max_confirm';
    profile_id: string;
    max_title: string | null;
    tg_title: string;
}>;
export declare function listChannelLinksForMaxUser(bot: Bot, maxUserId: number): Promise<ChannelLinkWire[]>;
export declare function listChannelLinksForTelegramUser(tgToken: string, tgUserId: number): Promise<ChannelLinkWire[]>;
/** Подставляет основной TG-токен в старые miniapp-цепочки с пустым bot_token. */
export declare function repairLegacyMiniappTgChains(): Promise<number>;
export declare function getOwnerProfileBundle(profileId: string): {
    profile_id: string;
    accounts: Array<{
        platform: string;
        platform_user_id: string;
        username: string | null;
        first_name: string | null;
        last_name: string | null;
        photo_url: string | null;
    }>;
};
