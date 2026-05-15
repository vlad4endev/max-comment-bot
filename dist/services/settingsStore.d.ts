/**
 * Links a user to a channel for admin notifications (delegates to {@link channelNotifyLinkStore}).
 */
export declare const settingsStore: {
    /** User ids linked to this channel for admin / comment notifications (from {@link channelNotifyLinkStore}). */
    getUsersLinkedToChannel(channelChatId: number): number[];
    getLinkedChannels(userId: number): number[];
    linkUserToChannel(userId: number, channelChatId: number): void;
    forcePersist(): Promise<void>;
};
