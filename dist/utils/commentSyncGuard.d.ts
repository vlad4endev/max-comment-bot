/**
 * commentSyncGuard.ts
 *
 * Защита от бесконечного цикла синхронизации комментариев.
 * Когда мы сами отправляем комментарий из TG в Max (или наоборот),
 * помечаем его ID здесь — чтобы обратный watcher не создал дубль.
 *
 * TTL 60 секунд достаточно: polling/webhook работает быстрее.
 */
export declare function markCommentSynced(id: string): void;
export declare function isCommentSynced(id: string): boolean;
