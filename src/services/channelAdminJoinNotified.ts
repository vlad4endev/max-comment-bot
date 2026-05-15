/**
 * In-memory: we already sent the "bot joined with admin rights" admin notification for this chat.
 * Cleared when a channel is fully disconnected. Survives pending→admin transitions without duplicate notify.
 */
const channelsAdminJoinNotified = new Set<number>()

export function clearAdminJoinNotifiedForChannel(channelChatId: number): void {
  channelsAdminJoinNotified.delete(channelChatId)
}

export function hasChannelAdminJoinNotified(channelChatId: number): boolean {
  return channelsAdminJoinNotified.has(channelChatId)
}

export function markChannelAdminJoinNotified(channelChatId: number): void {
  channelsAdminJoinNotified.add(channelChatId)
}
