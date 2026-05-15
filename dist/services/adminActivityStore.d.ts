export type AdminActivityType = 'new_subscriber' | 'new_comment' | 'new_post_button' | 'admin_reply' | 'channel_added';
export interface AdminActivityEvent {
    type: AdminActivityType;
    timestamp: string;
    payload: Record<string, unknown>;
}
export declare function pushAdminActivity(type: AdminActivityType, payload?: Record<string, unknown>): void;
export declare function getRecentAdminActivity(limit: number): AdminActivityEvent[];
