import type { Bot } from '@maxhub/max-bot-api';
export type PurgeMaxPostsSource = 'auto' | 'forwarded' | 'posts_db' | 'feed';
export interface PurgeTgChainMaxPostsOptions {
    /** ISO — удалять посты, опубликованные не раньше этой даты. По умолчанию created_at связки. */
    sinceIso?: string;
    /** ISO — верхняя граница (не включительно). */
    untilIso?: string;
    dryRun?: boolean;
    limit?: number;
    /** auto: forwarded → posts_db → feed */
    source?: PurgeMaxPostsSource;
}
export interface PurgeTgChainMaxPostsResult {
    chain_id: string;
    max_chat_id: number;
    since: string;
    until: string | null;
    source_used: 'forwarded' | 'posts_db' | 'feed' | 'none';
    scanned_mids: number;
    deleted: number;
    failed: number;
    dry_run: boolean;
    sample_mids: string[];
}
/**
 * Удаляет из MAX посты связки: сначала tg_chain_forwarded, иначе posts SQLite, иначе лента канала.
 */
export declare function purgeTgChainForwardedMaxPosts(bot: Bot, chainId: string, options?: PurgeTgChainMaxPostsOptions): Promise<PurgeTgChainMaxPostsResult>;
