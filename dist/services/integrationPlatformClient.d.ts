import type { IntegrationPlatform } from './integrationsStore';
export interface PlatformTestResult {
    ok: boolean;
    info?: string;
    error?: string;
}
export interface PlatformChannelInfo {
    id: string;
    title: string;
    username?: string;
}
export declare function validateTelegramToken(token: string): Promise<PlatformTestResult>;
export declare function validateVkToken(token: string, groupId?: string): Promise<PlatformTestResult>;
export declare function testIntegration(platform: IntegrationPlatform, token: string, groupId?: string): Promise<PlatformTestResult>;
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
