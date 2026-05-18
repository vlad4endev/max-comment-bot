import type { ChatType } from '@maxhub/max-bot-api/types'
import type Database from 'better-sqlite3'

import { pushAdminActivity } from './adminActivityStore'
import { getDb } from '../db/database'
import { logger } from '../utils/logger'

/**
 * Persisted metadata for a chat where the bot is (or was) present.
 */
export interface ChannelRecord {
  chat_id: number
  title: string | null
  type: ChatType
  /** ISO 8601 timestamp — set when the channel is first registered */
  date_added: string
}

/**
 * Fields supplied when registering or refreshing a channel (without {@link ChannelRecord.chat_id}).
 */
export interface ChannelSaveInput {
  title: string | null
  type: ChatType
}

function isChatType(value: unknown): value is ChatType {
  return value === 'dialog' || value === 'chat' || value === 'channel'
}

function isChannelRecord(value: unknown): value is ChannelRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const o = value as Record<string, unknown>
  return (
    typeof o.chat_id === 'number' &&
    Number.isInteger(o.chat_id) &&
    (o.title === null || typeof o.title === 'string') &&
    isChatType(o.type) &&
    typeof o.date_added === 'string'
  )
}

export class ChannelRegistry {
  private statements: {
    getById: Database.Statement
    listAll: Database.Statement
    upsert: Database.Statement
    deleteById: Database.Statement
  } | null = null

  async loadFromDisk(): Promise<void> {
    logger.debug('channelRegistry: SQLite backend active, loadFromDisk noop')
  }

  /**
   * Сохраняет или обновляет канал. Для уже известного `chat_id` поле {@link ChannelRecord.date_added} не меняется.
   */
  saveChannel(chatId: number, chatData: ChannelSaveInput): void {
    const existing = this.getChannel(chatId)
    const record: ChannelRecord = existing
      ? {
          ...existing,
          title: chatData.title ?? existing.title,
          type: chatData.type,
        }
      : {
          chat_id: chatId,
          title: chatData.title,
          type: chatData.type,
          date_added: new Date().toISOString(),
        }
    const isNew = !existing
    this.getStatements().upsert.run(
      record.chat_id,
      record.title,
      record.type,
      record.date_added,
      1,
      JSON.stringify(record),
    )
    if (isNew) {
      pushAdminActivity('channel_added', {
        chat_id: chatId,
        title: record.title,
      })
    }
  }

  /**
   * Исключает канал из поллера и реестра без удаления постов/комментариев (повторные ошибки API).
   */
  deactivate(chatId: number): ChannelRecord | null {
    return this.removeChannel(chatId)
  }

  /**
   * Удаляет канал из реестра. Возвращает удалённую запись (для текста уведомления) или `null`, если чата не было.
   */
  removeChannel(chatId: number): ChannelRecord | null {
    const prev = this.getChannel(chatId)
    if (prev === null) {
      return null
    }
    this.getStatements().deleteById.run(chatId)
    return prev
  }

  /**
   * Возвращает запись по `chat_id` или `null`.
   */
  getChannel(chatId: number): ChannelRecord | null {
    const row = this.getStatements().getById.get(chatId) as
      | {
          chat_id: number
          title: string | null
          type: ChatType
          date_added: string
          settings: string | null
        }
      | undefined
    if (!row) {
      return null
    }
    return this.parseRow(row)
  }

  /**
   * Все каналы из текущего реестра, отсортированные по `chat_id`.
   */
  getAllChannels(): ChannelRecord[] {
    const rows = this.getStatements().listAll.all() as Array<{
      chat_id: number
      title: string | null
      type: ChatType
      date_added: string
      settings: string | null
    }>
    return rows.map((row) => this.parseRow(row))
  }

  private parseRow(row: {
    chat_id: number
    title: string | null
    type: ChatType
    date_added: string
    settings: string | null
  }): ChannelRecord {
    if (row.settings) {
      try {
        const parsed = JSON.parse(row.settings) as unknown
        if (isChannelRecord(parsed)) {
          return parsed
        }
      } catch (error) {
        logger.warn('channelRegistry: failed to parse settings JSON, fallback to columns', {
          chatId: row.chat_id,
          error,
        })
      }
    }
    return {
      chat_id: row.chat_id,
      title: row.title,
      type: row.type,
      date_added: row.date_added,
    }
  }

  private getStatements(): NonNullable<ChannelRegistry['statements']> {
    if (this.statements) {
      return this.statements
    }
    const db = getDb()
    this.statements = {
      getById: db.prepare(
        'SELECT chat_id, title, type, date_added, settings FROM channels WHERE chat_id = ?',
      ),
      listAll: db.prepare('SELECT chat_id, title, type, date_added, settings FROM channels ORDER BY chat_id ASC'),
      upsert: db.prepare(
        'INSERT OR REPLACE INTO channels (chat_id, title, type, date_added, active, settings) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      deleteById: db.prepare('DELETE FROM channels WHERE chat_id = ?'),
    }
    return this.statements
  }
}

export const channelRegistry = new ChannelRegistry()
