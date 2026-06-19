import { type PostPlatform } from '../db/postsDatabase';
export type AutopostStatus = 'draft' | 'active' | 'sent' | 'paused' | 'failed';
export type AutopostScheduleType = 'once' | 'recurring';
export type AutopostMediaType = 'photo' | 'video';
export type AutopostOnFailure = 'skip' | 'retry_15m' | 'stop_series' | 'notify';
export interface AutopostMediaItem {
    type: AutopostMediaType;
    path: string;
}
/** Палитра цветов для тегов автопостов. */
export declare const AUTOPOST_TAG_COLORS: readonly ["#7F77DD", "#1D9E75", "#BA7517", "#3B82F6", "#EC4899", "#EF4444", "#6B7280", "#EAB308"];
export interface AutopostTag {
    name: string;
    color: string;
}
export interface AutopostInlineButton {
    text: string;
    url: string;
}
/** Rows of inline link buttons (each inner array = one row in Telegram / MAX). */
export type AutopostInlineKeyboard = AutopostInlineButton[][];
export interface AutopostCondition {
    id: string;
    type: 'min_subscribers' | 'max_posts_per_day' | 'min_interval_hours' | 'hours_range' | 'weekdays_only';
    operator: '>=' | '<=' | '=';
    value: string | number;
}
export interface AutopostRecord {
    id: string;
    platform: PostPlatform;
    text: string;
    media: AutopostMediaItem[];
    inline_button: AutopostInlineButton | null;
    inline_buttons: AutopostInlineKeyboard | null;
    tags: AutopostTag[];
    target_channel_id: string;
    channel_title: string | null;
    series_id: string | null;
    status: AutopostStatus;
    schedule_type: AutopostScheduleType;
    scheduled_at: string;
    recurring_time: string | null;
    weekdays: number[] | null;
    daily_times: string[] | null;
    timezone: string;
    start_date: string | null;
    end_date: string | null;
    repeat_limit: number | null;
    on_failure: AutopostOnFailure;
    conditions: AutopostCondition[];
    last_sent_at: string | null;
    last_error: string | null;
    sent_count: number;
    platform_message_id: string | null;
    created_at: string;
    updated_at: string;
}
export interface CreateAutopostInput {
    platform?: PostPlatform;
    text: string;
    media?: AutopostMediaItem[];
    inline_button?: AutopostInlineButton | null;
    inline_buttons?: AutopostInlineKeyboard | null;
    tags?: AutopostTag[];
    target_channel_id: string;
    channel_title?: string | null;
    series_id?: string | null;
    schedule_type: AutopostScheduleType;
    scheduled_at: string;
    recurring_time?: string | null;
    weekdays?: number[] | null;
    daily_times?: string[] | null;
    timezone?: string;
    start_date?: string | null;
    end_date?: string | null;
    repeat_limit?: number | null;
    on_failure?: AutopostOnFailure;
    conditions?: AutopostCondition[];
    status?: AutopostStatus;
}
export interface UpdateAutopostInput {
    platform?: PostPlatform;
    text?: string;
    media?: AutopostMediaItem[];
    inline_button?: AutopostInlineButton | null;
    inline_buttons?: AutopostInlineKeyboard | null;
    tags?: AutopostTag[];
    target_channel_id?: string;
    channel_title?: string | null;
    series_id?: string | null;
    schedule_type?: AutopostScheduleType;
    scheduled_at?: string;
    recurring_time?: string | null;
    weekdays?: number[] | null;
    daily_times?: string[] | null;
    timezone?: string;
    start_date?: string | null;
    end_date?: string | null;
    repeat_limit?: number | null;
    on_failure?: AutopostOnFailure;
    conditions?: AutopostCondition[];
    status?: AutopostStatus;
    platform_message_id?: string | null;
}
export interface PostChannelRecord {
    id: string;
    platform: PostPlatform;
    title: string | null;
    username: string | null;
    color: string | null;
    is_active: boolean;
    subscribers_count: number;
}
export declare function normalizeInlineKeyboard(input: unknown): AutopostInlineKeyboard | null;
export declare function primaryInlineButton(keyboard: AutopostInlineKeyboard | null): AutopostInlineButton | null;
export declare function resolveInlineKeyboard(buttons?: AutopostInlineKeyboard | null, legacy?: AutopostInlineButton | null): AutopostInlineKeyboard | null;
export declare function normalizeAutopostTags(input: unknown): AutopostTag[];
export declare function upsertPostChannel(input: {
    id: string;
    platform: PostPlatform;
    title?: string | null;
    username?: string | null;
    color?: string | null;
    subscribers_count?: number;
}): void;
export declare function listPostChannels(platform?: PostPlatform): PostChannelRecord[];
export declare function logPostPublish(input: {
    autopost_id: string;
    platform: PostPlatform;
    target_channel_id: string;
    status: 'success' | 'failed' | 'skipped';
    message?: string | null;
}): void;
export declare function listAutoposts(): AutopostRecord[];
export interface AutopostListFilters {
    status?: string;
    channelId?: string;
    platform?: PostPlatform;
    scheduleType?: AutopostScheduleType;
    search?: string;
    tag?: string;
    from?: string;
    to?: string;
}
export declare function listAutopostsFiltered(filters?: AutopostListFilters): AutopostRecord[];
export interface AutopostStats {
    totalPosts: number;
    scheduledCount: number;
    activeSeries: number;
    connectedChannels: number;
    totalSent: number;
    successRate: number;
    byChannel: {
        channelId: string;
        title: string;
        platform: PostPlatform;
        sent: number;
    }[];
    heatmap: number[][];
}
export declare function computeAutopostStats(posts: AutopostRecord[], channelCount: number): AutopostStats;
export declare function getAutopostById(id: string): AutopostRecord | null;
export declare function listDueAutoposts(nowIso: string): AutopostRecord[];
export declare function createAutopost(input: CreateAutopostInput): AutopostRecord;
export declare function updateAutopost(id: string, patch: UpdateAutopostInput): AutopostRecord | null;
export declare function markAutopostSent(id: string, opts: {
    nextScheduledAt?: string;
    status?: AutopostStatus;
    platformMessageId?: string;
}): AutopostRecord | null;
export declare function markAutopostFailed(id: string, error: string): AutopostRecord | null;
export declare function deleteAutopost(id: string): boolean;
export declare function setAutopostStatus(id: string, status: AutopostStatus): AutopostRecord | null;
export declare function purgeAutopostsForChannel(channelId: string, platform?: PostPlatform): number;
