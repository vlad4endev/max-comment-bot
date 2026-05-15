import { channelNotifyLinkStore } from './channelNotifyLinkStore'
import { disabledAdminStore } from './disabledAdminStore'
import { logger } from '../utils/logger'

/**
 * Links a user to a channel for admin notifications (delegates to {@link channelNotifyLinkStore}).
 */
export const settingsStore = {
  /** User ids linked to this channel for admin / comment notifications (from {@link channelNotifyLinkStore}). */
  getUsersLinkedToChannel(channelChatId: number): number[] {
    return channelNotifyLinkStore.getUserIdsForChannel(channelChatId)
  },

  getLinkedChannels(userId: number): number[] {
    const seen = new Set<number>()
    const channels: number[] = []
    for (const link of channelNotifyLinkStore.getAllLinks()) {
      if (link.user_id !== userId || seen.has(link.channel_chat_id)) {
        continue
      }
      seen.add(link.channel_chat_id)
      channels.push(link.channel_chat_id)
    }
    return channels
  },

  linkUserToChannel(userId: number, channelChatId: number): void {
    if (disabledAdminStore.isDisabled(userId)) {
      logger.info('settingsStore.linkUserToChannel skipped for disabled admin', { userId, chatId: channelChatId })
      return
    }
    const linkedChannelsBefore = this.getLinkedChannels(userId)
    const channelUsersBefore = this.getUsersLinkedToChannel(channelChatId)
    logger.info('settingsStore.linkUserToChannel called', {
      userId,
      chatId: channelChatId,
      wasAlreadyLinked: linkedChannelsBefore.includes(channelChatId),
      linkedChannelsBefore,
      channelUsersBefore,
    })
    channelNotifyLinkStore.register(userId, channelChatId)
    this.forcePersist().catch((err: unknown) => {
      logger.error('settingsStore.linkUserToChannel forcePersist failed', { err, userId, chatId: channelChatId })
    })
    logger.info('settingsStore.linkUserToChannel saved', {
      userId,
      linkedChannelsAfter: this.getLinkedChannels(userId),
      channelUsersAfter: this.getUsersLinkedToChannel(channelChatId),
    })
  },

  forcePersist(): Promise<void> {
    return channelNotifyLinkStore.forcePersist()
  },
}
