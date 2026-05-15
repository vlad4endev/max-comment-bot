/**
 * Links a user to a channel for admin notifications (delegates to {@link channelNotifyLinkStore}).
 */
export declare const settingsStore: {
    linkUserToChannel(userId: number, channelChatId: number): void;
    forcePersist(): Promise<void>;
};
