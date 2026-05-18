export type DashboardPeriodDays = 7 | 30 | 0;
export interface DashboardTimeseriesPoint {
    date: string;
    comments: number;
    posts: number;
    subscribers: number;
}
export interface DashboardChannelRow {
    chat_id: number;
    title: string | null;
    status: 'pending' | 'active';
    post_count: number;
    comment_count: number;
    posts_in_period: number;
    comments_in_period: number;
    unique_commenters: number;
    replied_count: number;
    reply_rate: number;
    engagement_rate: number;
    notify_links: number;
    last_activity_at: string | null;
}
export interface DashboardEffectiveness {
    score: number;
    grade: 'excellent' | 'good' | 'fair' | 'low';
    label: string;
    engagement_rate: number;
    reply_rate: number;
    coverage_rate: number;
    activation_rate: number;
    posts_with_comments_pct: number;
    insights: string[];
}
export interface DashboardPayload {
    period_days: DashboardPeriodDays;
    generated_at: string;
    totals: {
        channels: number;
        channels_active: number;
        channels_pending: number;
        bot_subscribers: number;
        posts: number;
        comments: number;
        posts_in_period: number;
        comments_in_period: number;
        admin_replies_in_period: number;
        subscribers_in_period: number;
        unique_commenters_in_period: number;
        unique_commenters_all: number;
    };
    funnel: {
        bot_subscribers: number;
        notify_opt_ins: number;
        unique_commenters: number;
        miniapp_users: number;
    };
    effectiveness: DashboardEffectiveness;
    timeseries: DashboardTimeseriesPoint[];
    channels: DashboardChannelRow[];
}
export declare function parseDashboardPeriodDays(raw: unknown): DashboardPeriodDays;
export declare function buildDashboardAnalytics(periodDays: DashboardPeriodDays): DashboardPayload;
