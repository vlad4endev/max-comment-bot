import { getDb } from '../db/database'

/** Каналы TG, для которых уже отправили уведомление «бот подключён с правами админа». */
const channelsAdminJoinNotified = new Set<string>()
let cacheLoaded = false

function normalizeChatId(channelChatId: string): string {
  return String(channelChatId).trim()
}

function ensureCacheLoaded(): void {
  if (cacheLoaded) {
    return
  }
  const rows = getDb()
    .prepare('SELECT chat_id FROM tg_channels WHERE admin_join_notified = 1')
    .all() as Array<{ chat_id: string }>
  for (const row of rows) {
    channelsAdminJoinNotified.add(normalizeChatId(row.chat_id))
  }
  cacheLoaded = true
}

export function clearTelegramAdminJoinNotified(channelChatId: string): void {
  ensureCacheLoaded()
  const id = normalizeChatId(channelChatId)
  channelsAdminJoinNotified.delete(id)
  getDb()
    .prepare('UPDATE tg_channels SET admin_join_notified = 0 WHERE chat_id = ?')
    .run(id)
}

export function hasTelegramAdminJoinNotified(channelChatId: string): boolean {
  ensureCacheLoaded()
  return channelsAdminJoinNotified.has(normalizeChatId(channelChatId))
}

export function markTelegramAdminJoinNotified(channelChatId: string): void {
  ensureCacheLoaded()
  const id = normalizeChatId(channelChatId)
  channelsAdminJoinNotified.add(id)
  getDb()
    .prepare('UPDATE tg_channels SET admin_join_notified = 1 WHERE chat_id = ?')
    .run(id)
}
