import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { logger } from '../utils/logger'

export const MINIAPP_FEATURE_KEYS = [
  'comments',
  'notifications',
  'moderation',
  'auto_replies',
] as const

export type MiniappFeatureKey = (typeof MINIAPP_FEATURE_KEYS)[number]

export interface MiniappUserSettings {
  comments: boolean
  notifications: boolean
  moderation: boolean
  auto_replies: boolean
}

const DEFAULT_SETTINGS: MiniappUserSettings = {
  comments: true,
  notifications: true,
  moderation: false,
  auto_replies: false,
}

interface SettingsFileShape {
  users: Record<string, Partial<Record<MiniappFeatureKey, boolean>>>
}

const DEFAULT_PATH = join(process.cwd(), 'data', 'settings.json')

function isFeatureKey(value: unknown): value is MiniappFeatureKey {
  return (
    typeof value === 'string' &&
    (MINIAPP_FEATURE_KEYS as readonly string[]).includes(value)
  )
}

function mergeWithDefaults(
  partial: Partial<Record<MiniappFeatureKey, boolean>> | undefined,
): MiniappUserSettings {
  return {
    comments: partial?.comments ?? DEFAULT_SETTINGS.comments,
    notifications: partial?.notifications ?? DEFAULT_SETTINGS.notifications,
    moderation: partial?.moderation ?? DEFAULT_SETTINGS.moderation,
    auto_replies: partial?.auto_replies ?? DEFAULT_SETTINGS.auto_replies,
  }
}

/**
 * JSON-backed per-user Mini App toggles (`data/settings.json`).
 */
export class UserMiniappSettingsStore {
  private readonly byUserId = new Map<number, Partial<Record<MiniappFeatureKey, boolean>>>()
  private readonly filePath: string
  private persistChain: Promise<void> = Promise.resolve()

  constructor(filePath: string = DEFAULT_PATH) {
    this.filePath = filePath
  }

  async loadFromDisk(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw) as unknown
      if (typeof parsed !== 'object' || parsed === null || !('users' in parsed)) {
        logger.warn('userMiniappSettingsStore: invalid settings.json shape, starting empty')
        this.byUserId.clear()
        return
      }
      const users = (parsed as SettingsFileShape).users
      if (typeof users !== 'object' || users === null || Array.isArray(users)) {
        this.byUserId.clear()
        return
      }
      this.byUserId.clear()
      for (const [k, v] of Object.entries(users)) {
        const id = Number.parseInt(k, 10)
        if (!Number.isInteger(id) || id <= 0 || typeof v !== 'object' || v === null) {
          continue
        }
        const row: Partial<Record<MiniappFeatureKey, boolean>> = {}
        for (const fk of MINIAPP_FEATURE_KEYS) {
          if (fk in v && typeof (v as Record<string, unknown>)[fk] === 'boolean') {
            row[fk] = (v as Record<string, unknown>)[fk] as boolean
          }
        }
        this.byUserId.set(id, row)
      }
      logger.info(`userMiniappSettingsStore: loaded ${this.byUserId.size} user row(s)`)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        logger.debug('userMiniappSettingsStore: settings.json missing, empty store')
        return
      }
      logger.error('userMiniappSettingsStore: failed to read settings.json', e)
    }
  }

  getMerged(userId: number): MiniappUserSettings {
    return mergeWithDefaults(this.byUserId.get(userId))
  }

  setFeature(userId: number, feature: MiniappFeatureKey, enabled: boolean): MiniappUserSettings {
    const prev = this.byUserId.get(userId) ?? {}
    const next = { ...prev, [feature]: enabled }
    this.byUserId.set(userId, next)
    this.queuePersist()
    return mergeWithDefaults(next)
  }

  private queuePersist(): void {
    this.persistChain = this.persistChain
      .then(() => this.persist())
      .catch((e: unknown) => {
        logger.error('userMiniappSettingsStore: persist error', e)
      })
  }

  private async persist(): Promise<void> {
    const dir = dirname(this.filePath)
    await mkdir(dir, { recursive: true })
    const users: Record<string, Partial<Record<MiniappFeatureKey, boolean>>> = {}
    for (const [uid, row] of this.byUserId) {
      users[String(uid)] = { ...row }
    }
    const body: SettingsFileShape = { users }
    await writeFile(this.filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  }
}

export function parseMiniappFeatureKey(value: unknown): MiniappFeatureKey | null {
  return isFeatureKey(value) ? value : null
}

export const userMiniappSettingsStore = new UserMiniappSettingsStore()
