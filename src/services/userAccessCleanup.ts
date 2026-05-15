import { channelNotifyLinkStore } from './channelNotifyLinkStore'
import { stateManager } from './stateManager'
import { subscriberStore } from './subscriberStore'
import { userMiniappSettingsStore } from './userMiniappSettingsStore'

/**
 * Fully removes user access to this bot from local storage-backed stores.
 */
export function fullyRemoveUserFromBot(userId: number): void {
  subscriberStore.removeSubscriber(userId)
  channelNotifyLinkStore.removeAllForUser(userId)
  userMiniappSettingsStore.removeUser(userId)
  stateManager.clearAllStatesForUser(userId)
  stateManager.clearUserPrivateChatId(userId)
}
