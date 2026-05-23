import type Database from 'better-sqlite3'

import { getDb } from '../db/database'

interface TelegramUserProfile {
  id: number
  username?: string
  first_name?: string
  last_name?: string
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

export class TelegramBotUserStore {
  private statements:
    | {
        upsertStarted: Database.Statement
      }
    | null = null

  markStarted(profile: TelegramUserProfile): void {
    if (!isPositiveInt(profile.id)) {
      return
    }
    const username = typeof profile.username === 'string' ? profile.username.trim() : ''
    const firstName = typeof profile.first_name === 'string' ? profile.first_name.trim() : ''
    const lastName = typeof profile.last_name === 'string' ? profile.last_name.trim() : ''
    this.getStatements().upsertStarted.run(
      profile.id,
      username || null,
      firstName || null,
      lastName || null,
    )
  }

  hasStarted(userId: number): boolean {
    return this.getStartedIds([userId]).has(userId)
  }

  getStartedIds(userIds: number[]): Set<number> {
    const normalized = [...new Set(userIds.filter((id) => isPositiveInt(id)))]
    if (normalized.length === 0) {
      return new Set<number>()
    }
    const placeholders = normalized.map(() => '?').join(', ')
    const stmt = getDb().prepare(
      `SELECT user_id FROM tg_bot_users WHERE user_id IN (${placeholders}) AND started = 1`,
    )
    const rows = stmt.all(...normalized) as Array<{ user_id: number }>
    return new Set(rows.map((row) => row.user_id))
  }

  private getStatements(): NonNullable<TelegramBotUserStore['statements']> {
    if (this.statements) {
      return this.statements
    }
    const db = getDb()
    this.statements = {
      upsertStarted: db.prepare(`
        INSERT INTO tg_bot_users (
          user_id, username, first_name, last_name, started, started_at, last_seen_at
        ) VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))
        ON CONFLICT(user_id) DO UPDATE SET
          username = COALESCE(excluded.username, tg_bot_users.username),
          first_name = COALESCE(excluded.first_name, tg_bot_users.first_name),
          last_name = COALESCE(excluded.last_name, tg_bot_users.last_name),
          started = 1,
          started_at = COALESCE(tg_bot_users.started_at, datetime('now')),
          last_seen_at = datetime('now')
      `),
    }
    return this.statements
  }
}

export const telegramBotUserStore = new TelegramBotUserStore()
