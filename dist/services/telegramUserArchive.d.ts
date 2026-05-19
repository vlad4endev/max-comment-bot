import type { StagedPayload } from './channelImportService';
export declare function telegramUserArchiveConfigured(): boolean;
export declare function getTelegramUserApiId(): number | null;
export declare function getTelegramUserApiHash(): string;
export declare function getTelegramUserSession(): string;
export declare function fetchChannelArchiveForImport(channelKey: string, limit: number, jobId: number): Promise<Array<{
    messageId: number;
    payload: StagedPayload;
}>>;
