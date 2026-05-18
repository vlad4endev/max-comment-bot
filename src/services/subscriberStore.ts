import { getDb } from '../db/database'
import type Database from 'better-sqlite3'
import { logger } from '../utils/logger'

import { pushAdminActivity } from './adminActivityStore'

function isPositiveIntId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Users who pressed Start in the bot — eligible for DM when a channel replies to their comment.
 */
export class SubscriberStore {
  async loadFromDisk(): Promise<void> {
    logger.debug('subscriberStore: SQLite backend active, loadFromDisk noop')
  }

  addSubscriber(userId: number): void {
    if (!isPositiveIntId(userId)) {
      return
    }
    if (this.hasSubscriber(userId)) {
      return
    }
    this.getStatements().insert.run(userId, JSON.stringify({ user_id: userId }))
    logger.info('subscriberStore: addSubscriber', { userId })
    pushAdminActivity('new_subscriber', { user_id: userId })
  }

  hasSubscriber(userId: number): boolean {
    if (!isPositiveIntId(userId)) {
      return false
    }
    const row = this.getStatements().getById.get(userId) as { user_id: number } | undefined
    return row !== undefined
  }

  removeSubscriber(userId: number): void {
    if (!isPositiveIntId(userId)) {
      return
    }
    const result = this.getStatements().deleteById.run(userId)
    if ((result.changes ?? 0) === 0) {
      return
    }
    logger.info('subscriberStore: removeSubscriber', { userId })
  }

  getAllSubscribers(): number[] {
    const rows = this.getStatements().listAll.all() as { user_id: number }[]
    return rows.map((row) => row.user_id)
  }

  /** Очистка файла подписчиков (опасная зона в админке). */
  clearAllSubscribers(): void {
    this.getStatements().deleteAll.run()
    logger.warn('subscriberStore: clearAllSubscribers')
  }

  private statements:
    | {
        getById: Database.Statement
        listAll: Database.Statement
        insert: Database.Statement
        deleteById: Database.Statement
        deleteAll: Database.Statement
      }
    | null = null

  private getStatements(): NonNullable<SubscriberStore['statements']> {
    if (this.statements) {
      return this.statements
    }
    const db = getDb()
    this.statements = {
      getById: db.prepare('SELECT user_id FROM subscribers WHERE user_id = ?'),
      listAll: db.prepare('SELECT user_id FROM subscribers ORDER BY user_id ASC'),
      insert: db.prepare('INSERT OR IGNORE INTO subscribers (user_id, data) VALUES (?, ?)'),
      deleteById: db.prepare('DELETE FROM subscribers WHERE user_id = ?'),
      deleteAll: db.prepare('DELETE FROM subscribers'),
    }
    return this.statements
  }
}

export const subscriberStore = new SubscriberStore()
