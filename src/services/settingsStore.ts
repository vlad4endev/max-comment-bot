import { channelNotifyLinkStore } from './channelNotifyLinkStore'
import { logger } from '../utils/logger'

/**
 * Links a user to a channel for admin notifications (delegates to {@link channelNotifyLinkStore}).
 */
export const settingsStore = {
  linkUserToChannel(userId: number, channelChatId: number): void {
    logger.info('DEBUG linkUserToChannel', {
      userId,
      channelChatId,
      currentLinked: channelNotifyLinkStore.getUserIdsForChannel(channelChatId),
    })
    channelNotifyLinkStore.register(userId, channelChatId)
  },

  forcePersist(): Promise<void> {
    return channelNotifyLinkStore.forcePersist()
  },
}
