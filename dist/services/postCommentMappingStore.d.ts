import type { TgChainRecord } from '../api/adminPanelState';
export interface PostCommentMappingRow {
    chain_id: string;
    tg_msg_id: number;
    max_mid: string;
    tg_chat_id: number | null;
    tg_thread_chat_id: number | null;
    tg_thread_msg_id: number | null;
}
export declare function upsertPostCommentMapping(chainId: string, tgMsgId: number, maxMid: string, tgChatId: number | null): void;
export declare function linkThreadMessageToChannelPost(chainId: string, channelMsgId: number, threadChatId: number, threadMsgId: number): void;
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
