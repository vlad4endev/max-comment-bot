export declare const SCAN_IDLE_MAX = 5;
export interface ChannelImportJobView extends ChannelImportJobRow {
    scan_idle_max: number;
    status_hint: string | null;
    can_publish: boolean;
    reader_token_ok: boolean;
    reader_uses_main_token: boolean;
    user_archive_ready: boolean;
}
export interface ChannelImportJobRow {
    id: number;
    tg_channel: string;
    max_channel_id: string;
    status: string;
    import_source: string;
    scan_next_offset: number;
    scan_idle_rounds: number;
    staged_count: number;
    error_message: string | null;
    created_at: string | null;
    updated_at: string | null;
}
export type StagedPayload = {
    kind: 'text';
    text: string;
} | {
    kind: 'photo';
    caption: string;
    fileId?: string;
    localPath?: string;
} | {
    kind: 'video';
    caption: string;
    fileId?: string;
    localPath?: string;
} | {
    kind: 'document';
    caption: string;
    fileId?: string;
    localPath?: string;
    fileName?: string;
    mimeType?: string;
};
export declare function resolveImportTgToken(): string;
export declare function readerTokenMeta(): {
    ok: boolean;
    usesMainToken: boolean;
};
export declare function assertTelegramPollingReady(tgToken: string): Promise<string | null>;
export declare function toChannelImportJobView(job: ChannelImportJobRow): ChannelImportJobView;
export declare function getActiveChannelImportJob(): ChannelImportJobView | undefined;
export declare function createChannelImportJob(tgChannel: string, maxChannelId: string, options?: {
    archive?: boolean;
    archiveLimit?: number;
}): number;
export declare function runArchiveImportJob(jobId: number, limit: number): Promise<void>;
export declare function getChannelImportJob(id: number): ChannelImportJobRow | undefined;
export declare function cancelChannelImportJob(id: number): boolean;
export declare function tickChannelImportJobs(): Promise<void>;
export declare function publishChannelImportJob(jobId: number, tgToken: string, maxToken: string): Promise<void>;
export declare function startChannelImportWorker(): void;
