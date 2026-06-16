/**
 * maxCommentSyncService.ts
 *
 * Периодически догоняет комментарии и ответы админа из MAX miniapp,
 * которые ещё не отправлены в TG discussion group.
 */
import type { Bot } from '@maxhub/max-bot-api';
interface SyncOptions {
    intervalMs?: number;
}
export declare function startMaxCommentSync(bot: Bot, options?: SyncOptions): () => void;
export {};
