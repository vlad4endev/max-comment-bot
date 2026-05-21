export interface TelegramChannelRecord {
    chat_id: string;
    title: string | null;
    username: string | null;
    type: string;
    bot_is_admin: boolean;
    updated_at: string;
}
export declare class TelegramChannelRegistry {
    private statements;
    saveChannel(input: {
        chatId: string;
        title?: string | null;
        username?: string | null;
        type?: string;
        botIsAdmin: boolean;
    }): void;
    getChannel(chatId: string): TelegramChannelRecord | null;
    getAllChannels(): TelegramChannelRecord[];
    private getStatements;
}
export declare const telegramChannelRegistry: TelegramChannelRegistry;
