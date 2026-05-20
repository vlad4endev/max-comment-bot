export type AutopostStatus = 'active' | 'sent' | 'paused' | 'failed';
export type AutopostScheduleType = 'once' | 'recurring';
export type AutopostMediaType = 'photo' | 'video';
export interface AutopostMediaItem {
    type: AutopostMediaType;
    path: string;
}
export interface AutopostInlineButton {
    text: string;
    url: string;
}
export interface AutopostRecord {
    id: string;
    text: string;
    media: AutopostMediaItem[];
    inline_button: AutopostInlineButton | null;
    target_channel_id: string;
    channel_title: string | null;
    status: AutopostStatus;
    schedule_type: AutopostScheduleType;
    scheduled_at: string;
    recurring_time: string | null;
    weekdays: number[] | null;
    timezone: string;
    last_sent_at: string | null;
    last_error: string | null;
    sent_count: number;
    created_at: string;
    updated_at: string;
}
export interface CreateAutopostInput {
    text: string;
    media?: AutopostMediaItem[];
    inline_button?: AutopostInlineButton | null;
    target_channel_id: string;
    channel_title?: string | null;
    schedule_type: AutopostScheduleType;
    scheduled_at: string;
    recurring_time?: string | null;
    weekdays?: number[] | null;
    timezone?: string;
}
export interface UpdateAutopostInput {
    text?: string;
    media?: AutopostMediaItem[];
    inline_button?: AutopostInlineButton | null;
    target_channel_id?: string;
    channel_title?: string | null;
    schedule_type?: AutopostScheduleType;
    scheduled_at?: string;
    recurring_time?: string | null;
    weekdays?: number[] | null;
    timezone?: string;
    status?: AutopostStatus;
}
export declare function listAutoposts(): AutopostRecord[];
export declare function getAutopostById(id: string): AutopostRecord | null;
export declare function listDueAutoposts(nowIso: string): AutopostRecord[];
export declare function createAutopost(input: CreateAutopostInput): AutopostRecord;
export declare function updateAutopost(id: string, patch: UpdateAutopostInput): AutopostRecord | null;
export declare function markAutopostSent(id: string, opts: {
    nextScheduledAt?: string;
    status?: AutopostStatus;
}): AutopostRecord | null;
export declare function markAutopostFailed(id: string, error: string): AutopostRecord | null;
export declare function deleteAutopost(id: string): boolean;
export declare function setAutopostStatus(id: string, status: AutopostStatus): AutopostRecord | null;
/** Удаляет автопосты, привязанные к TG-каналу (по абсолютному значению id). */
export declare function purgeAutopostsForChannel(channelId: string): number;
