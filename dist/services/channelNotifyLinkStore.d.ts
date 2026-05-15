/** User opted in via Mini App invite to receive comment notifications for this channel. */
export interface ChannelNotifyLink {
    user_id: number;
    channel_chat_id: number;
    joined_at: string;
}
/**
 * JSON-backed opt-in: which user_ids receive new-comment DMs for which channel.
 * When a channel has at least one link, only linked users are notified (instead of all API admins).
 */
export declare class ChannelNotifyLinkStore {
    private readonly links;
    private readonly filePath;
    private persistChain;
    constructor(filePath?: string);
    loadFromDisk(): Promise<void>;
    /**
     * Distinct user ids registered for comment notifications on this channel (order preserved).
     */
    getUserIdsForChannel(channelChatId: number): number[];
    isLinked(userId: number, channelChatId: number): boolean;
    register(userId: number, channelChatId: number): void;
    /** When the bot leaves a channel, drop all opt-ins for that chat. */
    removeAllForChannel(channelChatId: number): void;
    private queuePersist;
    private persist;
}
export declare const channelNotifyLinkStore: ChannelNotifyLinkStore;
