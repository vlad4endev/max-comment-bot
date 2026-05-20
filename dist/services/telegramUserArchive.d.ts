import type { StagedPayload } from './channelImportService';
export type ArchivePost = {
    messageId: number;
    payload: StagedPayload;
};
export declare function telegramUserArchiveConfigured(): boolean;
export declare function getTelegramUserApiId(): number | null;
export declare function getTelegramUserApiHash(): string;
export declare function getTelegramUserSession(): string;
export declare function fetchChannelArchiveForImport(channelKey: string, limit: number, jobId: number, onPost?: (post: ArchivePost) => Promise<void>): Promise<number>;
