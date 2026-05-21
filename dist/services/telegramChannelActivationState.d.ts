export declare const telegramChannelActivationState: {
    markChannelPendingAdminRights(channelChatId: string): void;
    clearChannelPendingAdminRights(channelChatId: string): void;
    isChannelPendingAdminRights(channelChatId: string): boolean;
    getPendingAdminChannelIds(): string[];
    setPendingAdminJoin(userId: number, channelChatId: string): void;
    getPendingAdminJoin(userId: number): string | undefined;
    clearPendingAdminJoinForUser(userId: number): void;
    clearPendingAdminJoinsForChannel(channelChatId: string): void;
};
