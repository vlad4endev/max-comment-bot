import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { resolveCanonicalChannelChatId } from './resolveChannelChatId'
import { logger } from '../utils/logger'

/** User opted in via Mini App invite to receive comment notifications for this channel. */
export interface ChannelNotifyLink {
  user_id: number
  channel_chat_id: number
  joined_at: string
}

interface FileShape {
  links: ChannelNotifyLink[]
}

const DEFAULT_PATH = join(process.cwd(), 'data', 'channel-notify-links.json')

function isLinkRow(value: unknown): value is ChannelNotifyLink {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const o = value as Record<string, unknown>
  return (
    typeof o.user_id === 'number' &&
    Number.isInteger(o.user_id) &&
    o.user_id > 0 &&
    typeof o.channel_chat_id === 'number' &&
    Number.isInteger(o.channel_chat_id) &&
    o.channel_chat_id !== 0 &&
    typeof o.joined_at === 'string'
  )
}

/**
 * JSON-backed opt-in: which user_ids receive new-comment DMs for which channel.
 * When a channel has at least one link, only linked users are notified (instead of all API admins).
 */
export class ChannelNotifyLinkStore {
  private readonly links: ChannelNotifyLink[] = []
  private readonly filePath: string
  private persistChain: Promise<void> = Promise.resolve()

  constructor(filePath: string = DEFAULT_PATH) {
    this.filePath = filePath
  }

  async loadFromDisk(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw) as unknown
      if (typeof parsed !== 'object' || parsed === null || !('links' in parsed)) {
        logger.warn('channelNotifyLinkStore: invalid file shape, starting empty')
        this.links.length = 0
        return
      }
      const list = (parsed as FileShape).links
      if (!Array.isArray(list)) {
        this.links.length = 0
        return
      }
      this.links.length = 0
      for (const item of list) {
        if (isLinkRow(item)) {
          this.links.push(item)
        }
      }
      logger.info(`channelNotifyLinkStore: loaded ${this.links.length} link(s)`)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        logger.debug('channelNotifyLinkStore: file missing, empty store')
        return
      }
      logger.error('channelNotifyLinkStore: failed to read file', e)
    }
  }

  /**
   * Distinct user ids registered for comment notifications on this channel (order preserved).
   */
  getUserIdsForChannel(channelChatId: number): number[] {
    const canonical = resolveCanonicalChannelChatId(channelChatId) ?? channelChatId
    const targetAbs = Math.abs(canonical)
    const seen = new Set<number>()
    const out: number[] = []
    for (const row of this.links) {
      if (Math.abs(row.channel_chat_id) !== targetAbs || seen.has(row.user_id)) {
        continue
      }
      seen.add(row.user_id)
      out.push(row.user_id)
    }
    return out
  }

  isLinked(userId: number, channelChatId: number): boolean {
    const canonical = resolveCanonicalChannelChatId(channelChatId) ?? channelChatId
    const targetAbs = Math.abs(canonical)
    return this.links.some(
      (r) => r.user_id === userId && Math.abs(r.channel_chat_id) === targetAbs,
    )
  }

  private normalizeChannelChatIds(canonicalChatId: number): boolean {
    const targetAbs = Math.abs(canonicalChatId)
    let changed = false
    for (const row of this.links) {
      if (Math.abs(row.channel_chat_id) === targetAbs && row.channel_chat_id !== canonicalChatId) {
        row.channel_chat_id = canonicalChatId
        changed = true
      }
    }
    return changed
  }

  register(userId: number, channelChatId: number): void {
    const canonical = resolveCanonicalChannelChatId(channelChatId) ?? channelChatId
    if (this.normalizeChannelChatIds(canonical)) {
      this.queuePersist()
    }
    logger.info('DEBUG channelNotifyLinkStore.register', {
      userId,
      channelChatId,
      canonicalChatId: canonical,
      currentLinkedForChannel: this.getUserIdsForChannel(canonical),
      alreadyLinked: this.isLinked(userId, canonical),
    })
    if (this.isLinked(userId, canonical)) {
      return
    }
    this.links.push({
      user_id: userId,
      channel_chat_id: canonical,
      joined_at: new Date().toISOString(),
    })
    this.queuePersist()
    logger.info('channelNotifyLinkStore: registered', { userId, channelChatId })
  }

  /** Await all queued writes so a following HTTP response or process restart sees the link. */
  async forcePersist(): Promise<void> {
    await this.persistChain
  }

  /**
   * Все связи user↔channel (копия).
   */
  getAllLinks(): ChannelNotifyLink[] {
    return [...this.links]
  }

  removeAllForUser(userId: number): void {
    const next = this.links.filter((r) => r.user_id !== userId)
    if (next.length === this.links.length) {
      return
    }
    this.links.length = 0
    this.links.push(...next)
    this.queuePersist()
    logger.info('channelNotifyLinkStore: removeAllForUser', { userId })
  }

  /** When the bot leaves a channel, drop all opt-ins for that chat. */
  removeAllForChannel(channelChatId: number): void {
    const canonical = resolveCanonicalChannelChatId(channelChatId) ?? channelChatId
    const targetAbs = Math.abs(canonical)
    const before = this.links.length
    const next = this.links.filter((r) => Math.abs(r.channel_chat_id) !== targetAbs)
    if (next.length === before) {
      return
    }
    this.links.length = 0
    this.links.push(...next)
    this.queuePersist()
    logger.info('channelNotifyLinkStore: removed links for channel', { channelChatId })
  }

  private queuePersist(): void {
    this.persistChain = this.persistChain
      .then(() => this.persist())
      .catch((e: unknown) => {
        logger.error('channelNotifyLinkStore: persist error', e)
      })
  }

  private async persist(): Promise<void> {
    const dir = dirname(this.filePath)
    await mkdir(dir, { recursive: true })
    const body: FileShape = { links: [...this.links] }
    await writeFile(this.filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  }
}

export const channelNotifyLinkStore = new ChannelNotifyLinkStore()
