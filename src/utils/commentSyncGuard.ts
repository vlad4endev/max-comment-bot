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
const MAX_ENTRIES = 20_000
let lastPruneAt = 0

function pruneExpired(now: number): void {
  if (now - lastPruneAt < 5_000 && synced.size < MAX_ENTRIES) {
    return
  }
  lastPruneAt = now
  for (const [id, expiresAt] of synced) {
    if (now >= expiresAt) {
      synced.delete(id)
    }
  }
  // Soft cap: drop oldest half if still oversized after TTL prune.
  if (synced.size > MAX_ENTRIES) {
    const entries = [...synced.entries()].sort((a, b) => a[1] - b[1])
    const dropCount = Math.ceil(entries.length / 2)
    for (let i = 0; i < dropCount; i += 1) {
      const key = entries[i]?.[0]
      if (key) {
        synced.delete(key)
      }
    }
  }
}

export function markCommentSynced(id: string): void {
  const now = Date.now()
  pruneExpired(now)
  synced.set(id, now + TTL_MS)
}

export function isCommentSynced(id: string): boolean {
  const expiresAt = synced.get(id)
  if (expiresAt === undefined) {
    return false
  }
  if (Date.now() >= expiresAt) {
    synced.delete(id)
    return false
  }
  return true
}
