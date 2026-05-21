import type { Bot } from '@maxhub/max-bot-api';
export interface ChannelSubscriberRow {
    channel_chat_id: number;
    user_id: number;
    name: string | null;
    username: string | null;
    avatar_url: string | null;
    is_admin: boolean;
    is_owner: boolean;
    join_time: number | null;
    last_activity_time: number | null;
    synced_at: string;
}
interface ChannelSyncMeta {
    channel_chat_id: number;
    last_synced_at: string;
    members_total: number;
}
export declare class ChannelSubscriberSnapshotStore {
    private statements;
    syncChannelSubscribers(bot: Bot, channelChatId: number): Promise<{
        members_total: number;
    }>;
    syncAllRegisteredChannels(bot: Bot): Promise<{
        synced_channels: number;
        failed_channels: number;
        members_total: number;
        channels: Array<{
            chat_id: number;
            title: string | null;
            members_total: number;
            ok: boolean;
            error?: string;
        }>;
    }>;
    listAllMembers(): ChannelSubscriberRow[];
    listMembersForUser(userId: number): ChannelSubscriberRow[];
    listChannelSyncMeta(): ChannelSyncMeta[];
    private getStatements;
}
export declare const channelSubscriberSnapshotStore: ChannelSubscriberSnapshotStore;
export {};
