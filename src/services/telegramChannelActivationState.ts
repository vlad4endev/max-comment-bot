/** Каналы TG, ожидающие выдачи боту прав администратора или повторного /connect. */
const pendingAdminChannelIds = new Set<string>()

/** userId → channelChatId: ожидание первого сообщения после jointg deep link. */
const pendingAdminJoinByUserId = new Map<number, string>()

function normalizeChatId(channelChatId: string): string {
  return String(channelChatId).trim()
}

export const telegramChannelActivationState = {
  markChannelPendingAdminRights(channelChatId: string): void {
    pendingAdminChannelIds.add(normalizeChatId(channelChatId))
  },

  clearChannelPendingAdminRights(channelChatId: string): void {
    pendingAdminChannelIds.delete(normalizeChatId(channelChatId))
  },

  isChannelPendingAdminRights(channelChatId: string): boolean {
    return pendingAdminChannelIds.has(normalizeChatId(channelChatId))
  },

  getPendingAdminChannelIds(): string[] {
    return [...pendingAdminChannelIds]
  },

  setPendingAdminJoin(userId: number, channelChatId: string): void {
    pendingAdminJoinByUserId.set(userId, normalizeChatId(channelChatId))
  },

  getPendingAdminJoin(userId: number): string | undefined {
    return pendingAdminJoinByUserId.get(userId)
  },

  clearPendingAdminJoinForUser(userId: number): void {
    pendingAdminJoinByUserId.delete(userId)
  },

  clearPendingAdminJoinsForChannel(channelChatId: string): void {
    const target = normalizeChatId(channelChatId)
    for (const [userId, ch] of pendingAdminJoinByUserId) {
      if (ch === target) {
        pendingAdminJoinByUserId.delete(userId)
      }
    }
  },
}
