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
export interface TelegramChatAdminInfo {
    userId: number;
    name: string;
    username?: string;
    isCreator: boolean;
    startedBot: boolean;
}
/** @deprecated используйте {@link listTelegramBotChats} */
export type TelegramLinkedChat = PlatformChannelInfo & {
    type: TelegramChatType;
    botIsAdmin: boolean;
};
/** Webhook блокирует getUpdates — для опроса и обнаружения чатов нужен polling. */
export declare function ensureTelegramPollingMode(token: string): Promise<void>;
export declare function mergePlatformChannels(existing: PlatformChannelInfo[] | undefined, discovered: PlatformChannelInfo[]): PlatformChannelInfo[];
/** Проверяет через getChatMember/getChat, где бот администратор (в т.ч. уже сохранённые чаты). */
export declare function enrichTelegramChatsWithBotAdmin(token: string, chats: PlatformChannelInfo[]): Promise<PlatformChannelInfo[]>;
export declare function validateTelegramToken(token: string): Promise<PlatformTestResult>;
export declare function validateVkToken(token: string, groupId?: string): Promise<PlatformTestResult>;
export declare function testIntegration(platform: IntegrationPlatform, token: string, groupId?: string): Promise<PlatformTestResult>;
/** Чаты/каналы, с которыми бот взаимодействовал (из getUpdates + my_chat_member). */
export declare function listTelegramBotChats(token: string, integrationId?: string): Promise<PlatformChannelInfo[]>;
export declare function listTelegramAdminChannels(token: string): Promise<PlatformChannelInfo[]>;
export declare function listTelegramChatAdministrators(token: string, chatId: string): Promise<TelegramChatAdminInfo[]>;
export declare function listVkGroups(token: string, groupId?: string): Promise<PlatformChannelInfo[]>;
export interface ExternalPost {
    externalId: string;
    text: string;
    hasMedia: boolean;
    createdAt?: number;
}
/**
 * Новые посты/сообщения из TG-канала, группы или супергруппы через getUpdates.
 * Каналы: channel_post; группы/чаты: message.
 *
 * Попутно собирает my_chat_member-события, где бот становится администратором,
 * и возвращает их в {@link discoveredChats} для немедленного обновления linkedChats.
 * Это необходимо, потому что оба механизма (опрос постов и обнаружение каналов)
 * используют один и тот же getUpdates offset — без такой инлайн-обработки
 * my_chat_member-события будут «съедены» поллером постов до того, как
 * listTelegramBotChats получит шанс их увидеть.
 */
export declare function fetchTelegramChannelPosts(token: string, integrationId: string, channelId: string, afterMessageId: number): Promise<{
    posts: ExternalPost[];
    lastMessageId: number;
    discoveredChats: PlatformChannelInfo[];
}>;
export declare function fetchVkWallPosts(token: string, groupId: string, afterPostId: number): Promise<{
    posts: ExternalPost[];
    lastPostId: number;
}>;
export declare function publishVkWallPost(token: string, groupId: string, message: string): Promise<void>;
