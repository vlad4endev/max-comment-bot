export declare const CHANNEL_LINK_DRAFT_TTL_MS: number;
export type ChannelLinkDraftStatus = 'pending' | 'awaiting_max_confirm' | 'completed' | 'expired' | 'cancelled';
export interface ChannelLinkDraftRow {
    code: string;
    profile_id: string;
    max_chat_id: number;
    max_user_id: number;
    max_title: string | null;
    status: ChannelLinkDraftStatus;
    tg_channel_id: string | null;
    tg_username: string | null;
    tg_user_id: number | null;
    chain_id: string | null;
    forward_posts: boolean;
    add_comments_button: boolean;
    created_at: string;
    expires_at: string;
}
export declare class ChannelLinkDraftStore {
    private statements;
    createDraft(input: {
        profileId: string;
        maxChatId: number;
        maxUserId: number;
        maxTitle: string | null;
    }): ChannelLinkDraftRow;
    getByCode(code: string): ChannelLinkDraftRow | null;
    markAwaitingMaxConfirm(code: string, patch: {
        tgChannelId: string;
        tgUsername: string;
        tgUserId: number;
        forwardPosts: boolean;
        addCommentsButton: boolean;
    }): void;
    markCompleted(code: string, patch: {
        tgChannelId: string;
        tgUsername: string;
        tgUserId: number;
        chainId: string;
    }): void;
    expireStale(): void;
    private getStatements;
}
export declare const channelLinkDraftStore: ChannelLinkDraftStore;
