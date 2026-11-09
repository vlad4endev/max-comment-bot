import { cacheClearAll } from '../cache/tieredCache'
import { reloadAdminPanelStateFromDisk } from '../api/adminPanelState'
import { closeAntispamDb, getAntispamDb } from '../db/antispamDatabase'
import { closeDb, getDb } from '../db/database'
import { closePostsDb, getPostsDb } from '../db/postsDatabase'
import { adminRuntimeSettingsStore } from './adminRuntimeSettingsStore'
import { reloadAntispamStore } from './antispamStore'
import { channelLinkDraftStore } from './channelLinkDraftStore'
import { channelNotifyLinkStore } from './channelNotifyLinkStore'
import { channelRegistry } from './channelRegistry'
import { channelSettingsStore } from './channelSettingsStore'
import { channelSubscriberSnapshotStore } from './channelSubscriberSnapshotStore'
import { commentStore } from './commentStore'
import { disabledAdminStore } from './disabledAdminStore'
import { flowStateStore } from './flowStateStore'
import { integrationsStore } from './integrationsStore'
import { logAiSettingsStore } from './logAiSettingsStore'
import { ownerProfileStore } from './ownerProfileStore'
import { postStore } from './postStore'
import { subscriberStore } from './subscriberStore'
import { telegramBotUserStore } from './telegramBotUserStore'
import { telegramChannelNotifyLinkStore } from './telegramChannelNotifyLinkStore'
import { telegramChannelRegistry } from './telegramChannelRegistry'
import { telegramProxyStore } from './telegramProxyStore'
import { invalidatePersistentMtprotoClient } from './telegramUserArchive'
import { userMiniappSettingsStore } from './userMiniappSettingsStore'
import { vkPostMappingStore } from './vkPostMappingStore'
import { logger } from '../utils/logger'

function checkpointAndClose(): void {
  try {
    getDb().pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    // база может быть ещё не открыта
  }
  closeDb()
  try {
    getPostsDb().pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    // ignore
  }
  closePostsDb()
  try {
    getAntispamDb().pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    // ignore
  }
  closeAntispamDb()
}

/** Закрыть живые SQLite перед подменой файлов, чтобы WAL не откатился поверх копии. */
export function closeDatabasesForRestore(): void {
  discardPreparedStatements()
  checkpointAndClose()
}

function discardPreparedStatements(): void {
  postStore.discardPreparedStatements()
  commentStore.discardPreparedStatements()
  channelRegistry.discardPreparedStatements()
  subscriberStore.discardPreparedStatements()
  channelSubscriberSnapshotStore.discardPreparedStatements()
  telegramBotUserStore.discardPreparedStatements()
  telegramChannelNotifyLinkStore.discardPreparedStatements()
  telegramChannelRegistry.discardPreparedStatements()
  channelLinkDraftStore.discardPreparedStatements()
  ownerProfileStore.discardPreparedStatements()
}

/**
 * Открыть базы заново и перечитать JSON-хранилища, которые держат данные в памяти.
 */
export async function reloadRuntimeAfterRestore(): Promise<void> {
  getDb()
  getPostsDb()
  getAntispamDb()
  discardPreparedStatements()
  await channelSettingsStore.loadFromDisk()
  await channelNotifyLinkStore.loadFromDisk()
  await userMiniappSettingsStore.loadFromDisk()
  await adminRuntimeSettingsStore.loadFromDisk()
  await disabledAdminStore.loadFromDisk()
  await logAiSettingsStore.loadFromDisk()
  await telegramProxyStore.loadFromDisk()
  await integrationsStore.reloadFromDisk()
  await flowStateStore.reloadFromDisk()
  await vkPostMappingStore.reloadFromDisk()
  await reloadAdminPanelStateFromDisk()
  reloadAntispamStore()
  invalidatePersistentMtprotoClient()
  await cacheClearAll()
  logger.info('backup: runtime reloaded after restore')
}
