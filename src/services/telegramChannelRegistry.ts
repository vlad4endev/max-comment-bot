import type Database from 'better-sqlite3'

import { getDb } from '../db/database'

export interface TelegramChannelRecord {
  chat_id: string
  title: string | null
  username: string | null
  type: string
  bot_is_admin: boolean
  updated_at: string
}

export class TelegramChannelRegistry {
  private statements:
    | {
        upsert: Database.Statement
        all: Database.Statement
        get: Database.Statement
      }
    | null = null

  saveChannel(input: {
    chatId: string
    title?: string | null
    username?: string | null
    type?: string
    botIsAdmin: boolean
  }): void {
    const chatId = String(input.chatId).trim()
    if (!/^-?\d+$/.test(chatId)) {
      return
    }
    const title =
      typeof input.title === 'string' && input.title.trim() !== '' ? input.title.trim() : null
    const username =
      typeof input.username === 'string' && input.username.trim() !== ''
        ? input.username.trim()
        : null
    const type = typeof input.type === 'string' && input.type.trim() !== '' ? input.type.trim() : 'channel'
    this.getStatements().upsert.run(
      chatId,
      title,
      username,
      type,
      input.botIsAdmin ? 1 : 0,
    )
  }

  getChannel(chatId: string): TelegramChannelRecord | null {
    const id = String(chatId).trim()
    const row = this.getStatements().get.get(id) as
      | {
          chat_id: string
          title: string | null
          username: string | null
          type: string
          bot_is_admin: number
          updated_at: string
        }
      | undefined
    if (!row) {
      return null
    }
    return {
      chat_id: row.chat_id,
      title: row.title,
      username: row.username,
      type: row.type,
      bot_is_admin: row.bot_is_admin === 1,
      updated_at: row.updated_at,
    }
  }

  getAllChannels(): TelegramChannelRecord[] {
    const rows = this.getStatements().all.all() as Array<{
      chat_id: string
      title: string | null
      username: string | null
      type: string
      bot_is_admin: number
      updated_at: string
    }>
    return rows.map((row) => ({
      chat_id: row.chat_id,
      title: row.title,
      username: row.username,
      type: row.type,
      bot_is_admin: row.bot_is_admin === 1,
      updated_at: row.updated_at,
    }))
  }

  private getStatements(): NonNullable<TelegramChannelRegistry['statements']> {
    if (this.statements) {
      return this.statements
    }
    const db = getDb()
    this.statements = {
      upsert: db.prepare(`
        INSERT INTO tg_channels (chat_id, title, username, type, bot_is_admin, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(chat_id) DO UPDATE SET
          title = COALESCE(excluded.title, tg_channels.title),
          username = COALESCE(excluded.username, tg_channels.username),
          type = COALESCE(excluded.type, tg_channels.type),
          bot_is_admin = excluded.bot_is_admin,
          updated_at = datetime('now')
      `),
      all: db.prepare(`
        SELECT chat_id, title, username, type, bot_is_admin, updated_at
        FROM tg_channels
        ORDER BY title COLLATE NOCASE ASC, chat_id ASC
      `),
      get: db.prepare(`
        SELECT chat_id, title, username, type, bot_is_admin, updated_at
        FROM tg_channels
        WHERE chat_id = ?
      `),
    }
    return this.statements
  }
}

export const telegramChannelRegistry = new TelegramChannelRegistry()
