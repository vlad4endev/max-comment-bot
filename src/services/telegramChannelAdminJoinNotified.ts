/** Каналы TG, для которых уже отправили уведомление «бот подключён с правами админа». */
const channelsAdminJoinNotified = new Set<string>()

function normalizeChatId(channelChatId: string): string {
  return String(channelChatId).trim()
}

export function clearTelegramAdminJoinNotified(channelChatId: string): void {
  channelsAdminJoinNotified.delete(normalizeChatId(channelChatId))
}

export function hasTelegramAdminJoinNotified(channelChatId: string): boolean {
  return channelsAdminJoinNotified.has(normalizeChatId(channelChatId))
}

export function markTelegramAdminJoinNotified(channelChatId: string): void {
  channelsAdminJoinNotified.add(normalizeChatId(channelChatId))
}
