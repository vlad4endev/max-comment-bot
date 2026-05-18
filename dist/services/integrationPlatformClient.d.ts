import type { IntegrationPlatform } from './integrationsStore';
export interface PlatformTestResult {
    ok: boolean;
    info?: string;
    error?: string;
}
export type TelegramChatType = 'channel' | 'group' | 'supergroup' | 'private' | 'unknown';
export interface PlatformChannelInfo {
    id: string;
    title: string;
    username?: string;
    type?: TelegramChatType;
    /** Бот — администратор (для каналов/групп). */
    botIsAdmin?: boolean;
}
/** @deprecated используйте {@link listTelegramBotChats} */
export type TelegramLinkedChat = PlatformChannelInfo & {
    type: TelegramChatType;
    botIsAdmin: boolean;
};
export declare function validateTelegramToken(token: string): Promise<PlatformTestResult>;
export declare function validateVkToken(token: string, groupId?: string): Promise<PlatformTestResult>;
export declare function testIntegration(platform: IntegrationPlatform, token: string, groupId?: string): Promise<PlatformTestResult>;
/** Чаты/каналы, с которыми бот взаимодействовал (из getUpdates + my_chat_member). */
export declare function listTelegramBotChats(token: string): Promise<PlatformChannelInfo[]>;
export declare function listTelegramAdminChannels(token: string): Promise<PlatformChannelInfo[]>;
export declare function listVkGroups(token: string, groupId?: string): Promise<PlatformChannelInfo[]>;
export interface ExternalPost {
    externalId: string;
    text: string;
    hasMedia: boolean;
    createdAt?: number;
}
export declare function fetchTelegramChannelPosts(token: string, channelId: string, afterMessageId: number): Promise<{
    posts: ExternalPost[];
    lastMessageId: number;
}>;
export declare function fetchVkWallPosts(token: string, groupId: string, afterPostId: number): Promise<{
    posts: ExternalPost[];
    lastPostId: number;
}>;
export declare function publishVkWallPost(token: string, groupId: string, message: string): Promise<void>;
