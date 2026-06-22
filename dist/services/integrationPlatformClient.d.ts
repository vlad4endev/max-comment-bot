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
/** Каналы из SQLite (my_chat_member / активация), которые могут отсутствовать в getUpdates. */
export declare function listTelegramChannelsFromRegistry(): PlatformChannelInfo[];
export declare function telegramLinkedChatsSnapshotChanged(before: PlatformChannelInfo[] | undefined, after: PlatformChannelInfo[]): boolean;
/** Список чатов для интеграции: кэш, getUpdates и реестр tg_channels. */
export declare function buildTelegramLinkedChatsList(options: {
    integrationId: string;
    token: string;
    existingLinkedChats?: PlatformChannelInfo[];
    refresh: boolean;
}): Promise<PlatformChannelInfo[]>;
export declare function mergePlatformChannels(existing: PlatformChannelInfo[] | undefined, discovered: PlatformChannelInfo[]): PlatformChannelInfo[];
export declare function getTelegramBotUserId(token: string): Promise<number | null>;
/** Проверяет через getChatMember/getChat, где бот администратор (в т.ч. уже сохранённые чаты). */
export declare function enrichTelegramChatsWithBotAdmin(token: string, chats: PlatformChannelInfo[]): Promise<PlatformChannelInfo[]>;
export declare function validateTelegramToken(token: string): Promise<PlatformTestResult>;
export declare function validateVkToken(token: string, groupId?: string): Promise<PlatformTestResult>;
export declare function testIntegration(platform: IntegrationPlatform, token: string, groupId?: string): Promise<PlatformTestResult>;
/** Разрешает @username / t.me/… / -100… в числовой chat_id через getChat. */
export declare function resolveTelegramChannelChatIdFromKey(token: string, channelKeyRaw: string): Promise<{
    chatId: string;
    title: string | null;
    username: string | null;
    type: TelegramChatType;
} | null>;
/** Чаты/каналы, с которыми бот взаимодействовал (из getUpdates + my_chat_member). */
export declare function listTelegramBotChats(token: string, integrationId?: string): Promise<PlatformChannelInfo[]>;
export declare function listTelegramAdminChannels(token: string): Promise<PlatformChannelInfo[]>;
export declare function listTelegramChatAdministrators(token: string, chatId: string): Promise<TelegramChatAdminInfo[]>;
export interface VkGroupInfo {
    /** Числовой ID без минуса */
    id: string;
    name: string;
    screenName: string;
    /** Правильная ссылка vk.com/{screenName} */
    url: string;
    photo?: string;
}
export interface VkGroupResolveResult {
    group: VkGroupInfo | null;
    error?: string;
}
export declare function listVkGroups(token: string, groupId?: string): Promise<PlatformChannelInfo[]>;
/**
 * Разрешает VK-сообщество из любого формата ввода:
 * числовой ID, -ID, URL (vk.com/...), slug (ostrovskidok).
 */
export declare function resolveVkGroup(token: string, input: string): Promise<VkGroupResolveResult>;
/**
 * Список сообществ, где токен имеет права администратора/редактора.
 */
export declare function listVkManagedGroups(token: string): Promise<VkGroupInfo[]>;
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
/** Загружает фото на стену VK; возвращает attachment вида photo{owner_id}_{id}. */
export declare function uploadVkWallPhotoFromBuffer(token: string, groupId: string, buffer: Buffer, filename?: string): Promise<string | null>;
/** Загружает видео в VK; возвращает attachment вида video{owner_id}_{id}. */
export declare function uploadVkWallVideoFromBuffer(token: string, groupId: string, buffer: Buffer, filename?: string, title?: string): Promise<string | null>;
export declare function publishVkWallPost(token: string, groupId: string, message: string, attachments?: string[]): Promise<number | null>;
/** Текущий текст VK-поста на стене. */
export declare function fetchVkWallPostText(token: string, groupId: string, postId: number): Promise<string | null>;
export declare function editVkWallPostMessage(token: string, groupId: string, postId: number, message: string): Promise<boolean>;
/** Дописывает маркер брони к тексту VK-поста, если его ещё нет. */
export declare function appendMarkerToVkWallPost(token: string, groupId: string, postId: number, marker: string): Promise<boolean>;
export interface VkComment {
    id: number;
    from_id: number;
    date: number;
    text: string;
    reply_to_comment?: number;
}
export declare function fetchVkWallComments(token: string, groupId: string, postId: number, afterCommentId: number): Promise<{
    comments: VkComment[];
    lastCommentId: number;
}>;
export declare function publishVkWallComment(token: string, groupId: string, postId: number, message: string, replyToCommentId?: number): Promise<number | null>;
