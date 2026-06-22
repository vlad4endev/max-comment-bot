/**
 * Диагностика и восстановление синхронизации комментариев MAX ↔ Telegram.
 */
export declare const STALE_UNDELIVERABLE_DAYS = 30;
export declare function staleUndeliverableCutoffIso(): string;
export declare function countStaleUndeliverableComments(chainId: string, staleCutoff?: string): number;
export declare function countFreshBlockedComments(chainId: string, staleCutoff?: string): number;
/** Списывает комментарии к постам старше STALE_UNDELIVERABLE_DAYS без треда (tg_comment_id = -1). */
export declare function purgeStaleUndeliverableComments(chainId: string): number;
export type CommentSyncIssueSeverity = 'critical' | 'warning' | 'info';
export interface CommentSyncIssue {
    severity: CommentSyncIssueSeverity;
    code: string;
    title: string;
    description: string;
    what_to_do: string;
}
export interface CommentSyncChainDiagnostics {
    chain_id: string;
    chain_name: string;
    active: boolean;
    forward_comments: boolean;
    discussion_chat_id: number | null;
    discussion_linked: boolean;
    bot_channel_admin: boolean | null;
    bot_discussion_member: boolean | null;
    mtproto_ready: boolean;
    send_as_mode: 'channel' | 'chat';
    mapping_stats: {
        total: number;
        with_thread: number;
        missing_thread: number;
    };
    pending_max_to_tg: number;
    issues: CommentSyncIssue[];
}
export interface CommentSyncDiagnosticsReport {
    checked_at: string;
    chains: CommentSyncChainDiagnostics[];
    deletion_watcher: {
        active: boolean;
        mtproto_ready: boolean;
    };
    log_signals_24h: {
        invalid_message_id: number;
        send_as_peer_invalid: number;
        forbidden: number;
        unauthorized: number;
        flood_wait: number;
        no_thread_mapping: number;
    };
    recommendations: string[];
}
export declare function diagnoseCommentSync(chainIdFilter?: string): Promise<CommentSyncDiagnosticsReport>;
export interface RepairThreadMappingsResult {
    chain_id: string;
    attempted: number;
    repaired: number;
    failed: number;
    pending_comments_repaired: number;
    samples: Array<{
        max_mid: string;
        tg_msg_id: number;
        ok: boolean;
    }>;
}
export declare function repairMissingThreadMappings(chainId: string, limit?: number, options?: {
    onlyWithPending?: boolean;
}): Promise<RepairThreadMappingsResult>;
export interface BootstrapCommentSyncResult {
    mappings_backfilled: number;
    chains_repaired: number;
    threads_repaired: number;
    threads_failed: number;
    pending_without_mapping: number;
}
/** На старте: backfill post_comment_mapping и починка тредов для активных цепочек. */
export declare function bootstrapCommentSyncOnStartup(options?: {
    threadRepairLimit?: number;
    repairThreads?: boolean;
}): Promise<BootstrapCommentSyncResult>;
