/**
 * commentSyncGuard.ts
 *
 * Защита от бесконечного цикла синхронизации комментариев.
 * Когда мы сами отправляем комментарий из TG в Max (или наоборот),
 * помечаем его ID здесь — чтобы обратный watcher не создал дубль.
 *
 * TTL 60 секунд достаточно: polling/webhook работает быстрее.
 */

const synced = new Map<string, number>()
const TTL_MS = 60_000

export function markCommentSynced(id: string): void {
  synced.set(id, Date.now())
  setTimeout(() => synced.delete(id), TTL_MS)
}

export function isCommentSynced(id: string): boolean {
  return synced.has(id)
}
