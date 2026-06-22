import type { Bot } from '@maxhub/max-bot-api';
export interface PurgeTgChainMaxPostsOptions {
    /** ISO — удалять посты, пересланные не раньше этой даты. По умолчанию created_at связки. */
    sinceIso?: string;
    /** ISO — верхняя граница forwarded_at (не включительно). */
    untilIso?: string;
    dryRun?: boolean;
    limit?: number;
}
export interface PurgeTgChainMaxPostsResult {
    chain_id: string;
    max_chat_id: number;
    since: string;
    until: string | null;
    scanned_mids: number;
    deleted: number;
    failed: number;
    dry_run: boolean;
    sample_mids: string[];
}
/**
 * Удаляет из MAX посты, созданные пересылкой TG→MAX для связки (по tg_chain_forwarded).
 */
export declare function purgeTgChainForwardedMaxPosts(bot: Bot, chainId: string, options?: PurgeTgChainMaxPostsOptions): Promise<PurgeTgChainMaxPostsResult>;
