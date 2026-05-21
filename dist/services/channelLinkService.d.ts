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
    expires_at: string;
    status: string;
} | null;
export declare function confirmChannelLinkDraft(tgToken: string, input: {
    code: string;
    tgUserId: number;
    tgChannelId: string;
    account: OwnerAccountInput;
    forwardPosts?: boolean;
    addCommentsButton?: boolean;
}): Promise<{
    chain: ChannelLinkWire;
    profile_id: string;
}>;
export declare function listChannelLinksForMaxUser(bot: Bot, maxUserId: number): Promise<ChannelLinkWire[]>;
export declare function listChannelLinksForTelegramUser(tgToken: string, tgUserId: number): Promise<ChannelLinkWire[]>;
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
