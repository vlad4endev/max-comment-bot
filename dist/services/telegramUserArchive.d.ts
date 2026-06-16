import { TelegramClient } from 'telegram';
import type { EntityLike } from 'telegram/define';
import type { StagedPayload } from './channelImportService';
export type ArchivePost = {
    messageId: number;
    payload: StagedPayload;
};
export declare function telegramUserArchiveConfigured(): boolean;
export declare function getTelegramUserApiId(): number | null;
export declare function getTelegramUserApiHash(): string;
export declare function getTelegramUserSession(): string;
/** Подключение MTProto user-сессии (импорт TG→MAX, отправка в обсуждения от канала). */
export declare function connectTelegramUserClient(): Promise<TelegramClient>;
export declare function resolveTelegramChannelEntity(client: TelegramClient, channelKey: string): Promise<EntityLike>;
export declare function fetchChannelArchiveForImport(channelKey: string, limit: number, jobId: number, onPost?: (post: ArchivePost) => Promise<void>): Promise<number>;
