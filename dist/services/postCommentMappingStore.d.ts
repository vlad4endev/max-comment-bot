import { type TgChainRecord } from '../api/adminPanelState';
export interface PostCommentMappingRow {
    chain_id: string;
    tg_msg_id: number;
    max_mid: string;
    tg_chat_id: number | null;
    tg_thread_chat_id: number | null;
    tg_thread_msg_id: number | null;
}
/** Ключ TG-канала для API: предпочитаем tg_chat_id из маппинга (фактический источник поста). */
export declare function resolveTelegramChannelKeyForMapping(mapping: PostCommentMappingRow, chain?: TgChainRecord | null): string | null;
/** Уникальные ключи канала для GetDiscussionMessage (peer = канал, не discussion group). */
export declare function listTelegramChannelKeyCandidatesForMapping(mapping: PostCommentMappingRow, chain?: TgChainRecord | null, discussionChatId?: number | null): string[];
export declare function countMappingChannelIdMismatch(chainId: string): number;
export declare function upsertPostCommentMapping(chainId: string, tgMsgId: number, maxMid: string, tgChatId: number | null): void;
export declare function linkThreadMessageToChannelPost(chainId: string, channelMsgId: number, threadChatId: number, threadMsgId: number): void;
/** Сбрасывает устаревший thread id — для повторного resolve через GetDiscussionMessage. */
export declare function clearPostThreadMapping(chainId: string, tgMsgId: number): void;
/** Удаляет битый маппинг (MSG_ID_INVALID / удалённый пост в TG). */
export declare function deletePostCommentMapping(chainId: string, tgMsgId: number): boolean;
/** Пересоздаёт маппинг для max_mid из tg_chain_forwarded (последняя пересылка). */
export declare function backfillPostCommentMappingForMaxMid(maxMid: string): boolean;
export interface PostMappingThreadStats {
    total: number;
    with_thread: number;
    missing_thread: number;
}
export declare function countPostMappingThreadStats(chainId?: string): PostMappingThreadStats;
export declare function listMappingsMissingThread(chainId: string, limit?: number): PostCommentMappingRow[];
export declare function findMappingByThreadMsgId(chainId: string, threadMsgId: number): PostCommentMappingRow | null;
export declare function findMappingByTgMsgId(chainId: string, tgMsgId: number): PostCommentMappingRow | null;
export declare function findMappingByMaxMid(maxMid: string): PostCommentMappingRow | null;
/**
 * Заполняет post_comment_mapping из tg_chain_forwarded для постов,
 * пересланных до включения синхронизации комментариев.
 */
export declare function backfillPostCommentMappingsFromForwarded(): number;
export declare function resolveDiscussionChatId(tgToken: string, chain: TgChainRecord): Promise<number | null>;
/**
 * Раньше проставлял tg_thread_chat_id без tg_thread_msg_id — из-за этого
 * findMappingByMaxMid выбирал «битую» строку. Thread id задаётся через
 * handleDiscussionAutoForward / ensurePostThreadMapping.
 */
export declare function storeDiscussionChatIdForChain(_tgToken: string, _chain: TgChainRecord): Promise<void>;
