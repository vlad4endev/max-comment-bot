import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { logger } from '../utils/logger'

interface DisabledAdminsFileShape {
  disabled_user_ids: number[]
}

const DEFAULT_PATH = join(process.cwd(), 'data', 'disabled-admins.json')

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Stores user ids explicitly disabled from bot admin capabilities.
 */
export class DisabledAdminStore {
  private readonly disabledUserIds = new Set<number>()
  private readonly filePath: string
  private persistChain: Promise<void> = Promise.resolve()

  constructor(filePath: string = DEFAULT_PATH) {
    this.filePath = filePath
  }

  async loadFromDisk(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw) as unknown
      if (typeof parsed !== 'object' || parsed === null || !('disabled_user_ids' in parsed)) {
        logger.warn('disabledAdminStore: invalid file shape, starting empty')
        this.disabledUserIds.clear()
        return
      }
      const rows = (parsed as DisabledAdminsFileShape).disabled_user_ids
      if (!Array.isArray(rows)) {
        this.disabledUserIds.clear()
        return
      }
      this.disabledUserIds.clear()
      for (const row of rows) {
        if (isPositiveInt(row)) {
          this.disabledUserIds.add(row)
        }
      }
      logger.info(`disabledAdminStore: loaded ${this.disabledUserIds.size} disabled user(s)`)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        logger.debug('disabledAdminStore: file missing, empty store')
        return
      }
      logger.error('disabledAdminStore: failed to read file', e)
    }
  }

  isDisabled(userId: number): boolean {
    return isPositiveInt(userId) && this.disabledUserIds.has(userId)
  }

  disableUser(userId: number): void {
    if (!isPositiveInt(userId)) {
      return
    }
    if (this.disabledUserIds.has(userId)) {
      return
    }
    this.disabledUserIds.add(userId)
    this.queuePersist()
    logger.info('disabledAdminStore: disableUser', { userId })
  }

  private queuePersist(): void {
    this.persistChain = this.persistChain
      .then(() => this.persist())
      .catch((e: unknown) => {
        logger.error('disabledAdminStore: persist error', e)
      })
  }

  private async persist(): Promise<void> {
    const dir = dirname(this.filePath)
    await mkdir(dir, { recursive: true })
    const body: DisabledAdminsFileShape = {
      disabled_user_ids: [...this.disabledUserIds].sort((a, b) => a - b),
    }
    await writeFile(this.filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  }
}

export const disabledAdminStore = new DisabledAdminStore()
