import { channelNotifyLinkStore } from './channelNotifyLinkStore'

/**
 * Links a user to a channel for admin notifications (delegates to {@link channelNotifyLinkStore}).
 */
export const settingsStore = {
  linkUserToChannel(userId: number, channelChatId: number): void {
    channelNotifyLinkStore.register(userId, channelChatId)
  },
}
