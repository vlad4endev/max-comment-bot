import { getDb } from '../db/database'

/**
 * In-memory cache backed by SQLite: we already sent the "bot joined with admin rights"
 * admin notification for this chat. Cleared when a channel is fully disconnected.
 */
const channelsAdminJoinNotified = new Set<number>()
let cacheLoaded = false

function ensureCacheLoaded(): void {
  if (cacheLoaded) {
    return
  }
  const rows = getDb()
    .prepare('SELECT chat_id FROM channels WHERE admin_join_notified = 1')
    .all() as Array<{ chat_id: number }>
  for (const row of rows) {
    channelsAdminJoinNotified.add(row.chat_id)
  }
  cacheLoaded = true
}

export function clearAdminJoinNotifiedForChannel(channelChatId: number): void {
  ensureCacheLoaded()
  channelsAdminJoinNotified.delete(channelChatId)
  getDb()
    .prepare('UPDATE channels SET admin_join_notified = 0 WHERE chat_id = ?')
    .run(channelChatId)
}

export function hasChannelAdminJoinNotified(channelChatId: number): boolean {
  ensureCacheLoaded()
  return channelsAdminJoinNotified.has(channelChatId)
}

export function markChannelAdminJoinNotified(channelChatId: number): void {
  ensureCacheLoaded()
  channelsAdminJoinNotified.add(channelChatId)
  getDb()
    .prepare('UPDATE channels SET admin_join_notified = 1 WHERE chat_id = ?')
    .run(channelChatId)
}
