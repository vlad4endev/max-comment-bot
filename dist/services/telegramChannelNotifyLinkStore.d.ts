export interface TelegramChannelNotifyLink {
    user_id: number;
    channel_chat_id: string;
    joined_at: string;
}
export declare class TelegramChannelNotifyLinkStore {
    private statements;
    register(userId: number, channelChatId: string): void;
    isLinked(userId: number, channelChatId: string): boolean;
    getUserIdsForChannel(channelChatId: string): number[];
    getLinkedChannels(userId: number): string[];
    removeUserFromChannel(userId: number, channelChatId: string): void;
    removeAllForUser(userId: number): void;
    removeAllForChannel(channelChatId: string): void;
    private getStatements;
}
export declare const telegramChannelNotifyLinkStore: TelegramChannelNotifyLinkStore;
