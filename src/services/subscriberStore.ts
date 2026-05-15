import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { logger } from '../utils/logger'

import { pushAdminActivity } from './adminActivityStore'

interface FileShape {
  subscribers: number[]
}

const DEFAULT_PATH = join(process.cwd(), 'data', 'subscribers.json')

function isPositiveIntId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Users who pressed Start in the bot — eligible for DM when a channel replies to their comment.
 */
export class SubscriberStore {
  private readonly subscribers = new Set<number>()
  private readonly filePath: string
  private persistChain: Promise<void> = Promise.resolve()

  constructor(filePath: string = DEFAULT_PATH) {
    this.filePath = filePath
  }

  async loadFromDisk(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw) as unknown
      if (typeof parsed !== 'object' || parsed === null || !('subscribers' in parsed)) {
        logger.warn('subscriberStore: invalid file shape, starting empty')
        this.subscribers.clear()
        return
      }
      const list = (parsed as FileShape).subscribers
      if (!Array.isArray(list)) {
        this.subscribers.clear()
        return
      }
      this.subscribers.clear()
      for (const id of list) {
        if (isPositiveIntId(id)) {
          this.subscribers.add(id)
        }
      }
      logger.info(`subscriberStore: loaded ${this.subscribers.size} subscriber(s)`)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        logger.debug('subscriberStore: file missing, empty store')
        return
      }
      logger.error('subscriberStore: failed to read file', e)
    }
  }

  addSubscriber(userId: number): void {
    if (!isPositiveIntId(userId)) {
      return
    }
    if (this.subscribers.has(userId)) {
      return
    }
    this.subscribers.add(userId)
    this.queuePersist()
    logger.info('subscriberStore: addSubscriber', { userId })
    pushAdminActivity('new_subscriber', { user_id: userId })
  }

  hasSubscriber(userId: number): boolean {
    if (!isPositiveIntId(userId)) {
      return false
    }
    return this.subscribers.has(userId)
  }

  removeSubscriber(userId: number): void {
    if (!isPositiveIntId(userId)) {
      return
    }
    if (!this.subscribers.delete(userId)) {
      return
    }
    this.queuePersist()
    logger.info('subscriberStore: removeSubscriber', { userId })
  }

  getAllSubscribers(): number[] {
    return [...this.subscribers].sort((a, b) => a - b)
  }

  /** Очистка файла подписчиков (опасная зона в админке). */
  clearAllSubscribers(): void {
    if (this.subscribers.size === 0) {
      return
    }
    this.subscribers.clear()
    this.queuePersist()
    logger.warn('subscriberStore: clearAllSubscribers')
  }

  private queuePersist(): void {
    this.persistChain = this.persistChain
      .then(() => this.persist())
      .catch((e: unknown) => {
        logger.error('subscriberStore: persist error', e)
      })
  }

  private async persist(): Promise<void> {
    const dir = dirname(this.filePath)
    await mkdir(dir, { recursive: true })
    const body: FileShape = { subscribers: this.getAllSubscribers() }
    await writeFile(this.filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  }
}

export const subscriberStore = new SubscriberStore()
