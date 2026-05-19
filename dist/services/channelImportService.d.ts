export interface ChannelImportJobRow {
    id: number;
    tg_channel: string;
    max_channel_id: string;
    status: string;
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
    fileId: string;
} | {
    kind: 'video';
    caption: string;
    fileId: string;
} | {
    kind: 'document';
    caption: string;
    fileId: string;
    fileName?: string;
    mimeType?: string;
};
export declare function createChannelImportJob(tgChannel: string, maxChannelId: string): number;
export declare function getChannelImportJob(id: number): ChannelImportJobRow | undefined;
export declare function cancelChannelImportJob(id: number): boolean;
export declare function tickChannelImportJobs(): Promise<void>;
export declare function publishChannelImportJob(jobId: number, tgToken: string, maxToken: string): Promise<void>;
export declare function startChannelImportWorker(): void;
