import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { logger } from '../utils/logger'

export interface ChannelSettings {
  manager_url: string | null
}

const DEFAULT_SETTINGS: ChannelSettings = {
  manager_url: null,
}

interface ChannelSettingsRow {
  manager_url?: string | null
}

interface SettingsFileShape {
  channels: Record<string, ChannelSettingsRow>
}

const DEFAULT_PATH = join(process.cwd(), 'data', 'channel-settings.json')

function mergeRow(row: ChannelSettingsRow | undefined): ChannelSettings {
  const url = row?.manager_url
  if (typeof url === 'string') {
    const trimmed = url.trim()
    return { manager_url: trimmed === '' ? null : trimmed }
  }
  if (url === null) {
    return { manager_url: null }
  }
  return { ...DEFAULT_SETTINGS }
}

function isValidManagerUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Per-channel Mini App settings (e.g. manager contact link).
 */
export class ChannelSettingsStore {
  private readonly byChatId = new Map<number, ChannelSettingsRow>()
  private readonly filePath: string
  private persistChain: Promise<void> = Promise.resolve()

  constructor(filePath: string = DEFAULT_PATH) {
    this.filePath = filePath
  }

  async loadFromDisk(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw) as unknown
      if (typeof parsed !== 'object' || parsed === null || !('channels' in parsed)) {
        logger.warn('channelSettingsStore: invalid file shape, starting empty')
        this.byChatId.clear()
        return
      }
      const channels = (parsed as SettingsFileShape).channels
      if (typeof channels !== 'object' || channels === null || Array.isArray(channels)) {
        this.byChatId.clear()
        return
      }
      this.byChatId.clear()
      for (const [k, v] of Object.entries(channels)) {
        const id = Number.parseInt(k, 10)
        if (!Number.isInteger(id) || id === 0 || typeof v !== 'object' || v === null) {
          continue
        }
        this.byChatId.set(id, v as ChannelSettingsRow)
      }
      logger.info(`channelSettingsStore: loaded ${this.byChatId.size} channel row(s)`)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        logger.debug('channelSettingsStore: file missing, empty store')
        return
      }
      logger.error('channelSettingsStore: failed to read file', e)
    }
  }

  getSettings(chatId: number): ChannelSettings {
    return mergeRow(this.byChatId.get(chatId))
  }

  getManagerUrl(chatId: number): string | null {
    return this.getSettings(chatId).manager_url
  }

  removeChannel(chatId: number): void {
    const abs = Math.abs(chatId)
    let removed = false
    for (const key of [...this.byChatId.keys()]) {
      if (Math.abs(key) === abs) {
        this.byChatId.delete(key)
        removed = true
      }
    }
    if (removed) {
      this.queuePersist()
      logger.info('channelSettingsStore: removeChannel', { chatId })
    }
  }

  setManagerUrl(chatId: number, managerUrl: string | null): ChannelSettings {
    const prev = this.byChatId.get(chatId) ?? {}
    const next: ChannelSettingsRow = { ...prev }
    if (managerUrl === null) {
      next.manager_url = null
    } else {
      const trimmed = managerUrl.trim()
      if (trimmed !== '' && !isValidManagerUrl(trimmed)) {
        throw new Error('invalid manager_url')
      }
      next.manager_url = trimmed === '' ? null : trimmed
    }
    this.byChatId.set(chatId, next)
    this.queuePersist()
    return mergeRow(next)
  }

  private queuePersist(): void {
    this.persistChain = this.persistChain
      .then(() => this.persist())
      .catch((e: unknown) => {
        logger.error('channelSettingsStore: persist error', e)
      })
  }

  private async persist(): Promise<void> {
    const dir = dirname(this.filePath)
    await mkdir(dir, { recursive: true })
    const channels: Record<string, ChannelSettingsRow> = {}
    for (const [chatId, row] of this.byChatId) {
      channels[String(chatId)] = { ...row }
    }
    const body: SettingsFileShape = { channels }
    await writeFile(this.filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  }
}

export const channelSettingsStore = new ChannelSettingsStore()

export function parseManagerUrlInput(value: unknown): string | null | 'invalid' {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value !== 'string') {
    return 'invalid'
  }
  const trimmed = value.trim()
  if (trimmed === '') {
    return null
  }
  return isValidManagerUrl(trimmed) ? trimmed : 'invalid'
}
