import type Database from 'better-sqlite3'

import { getDb } from '../db/database'
import { logger } from '../utils/logger'

export interface TelegramChannelNotifyLink {
  user_id: number
  channel_chat_id: string
  joined_at: string
}

export class TelegramChannelNotifyLinkStore {
  private statements:
    | {
        register: Database.Statement
        isLinked: Database.Statement
        listForChannel: Database.Statement
        listForUser: Database.Statement
        removeUserFromChannel: Database.Statement
        removeAllForUser: Database.Statement
        removeAllForChannel: Database.Statement
      }
    | null = null

  register(userId: number, channelChatId: string): void {
    if (!Number.isInteger(userId) || userId <= 0) {
      return
    }
    const chatId = String(channelChatId).trim()
    if (!/^-?\d+$/.test(chatId)) {
      return
    }
    if (this.isLinked(userId, chatId)) {
      return
    }
    this.getStatements().register.run(userId, chatId)
    logger.info('telegramChannelNotifyLinkStore: registered', { userId, channelChatId: chatId })
  }

  isLinked(userId: number, channelChatId: string): boolean {
    const chatId = String(channelChatId).trim()
    const row = this.getStatements().isLinked.get(userId, chatId) as { n: number } | undefined
    return (row?.n ?? 0) > 0
  }

  getUserIdsForChannel(channelChatId: string): number[] {
    const chatId = String(channelChatId).trim()
    const rows = this.getStatements().listForChannel.all(chatId) as Array<{ user_id: number }>
    return rows.map((r) => r.user_id)
  }

  getLinkedChannels(userId: number): string[] {
    const rows = this.getStatements().listForUser.all(userId) as Array<{ channel_chat_id: string }>
    return rows.map((r) => r.channel_chat_id)
  }

  removeUserFromChannel(userId: number, channelChatId: string): void {
    const chatId = String(channelChatId).trim()
    this.getStatements().removeUserFromChannel.run(userId, chatId)
  }

  removeAllForUser(userId: number): void {
    this.getStatements().removeAllForUser.run(userId)
  }

  removeAllForChannel(channelChatId: string): void {
    const chatId = String(channelChatId).trim()
    this.getStatements().removeAllForChannel.run(chatId)
  }

  private getStatements(): NonNullable<TelegramChannelNotifyLinkStore['statements']> {
    if (this.statements) {
      return this.statements
    }
    const db = getDb()
    this.statements = {
      register: db.prepare(`
        INSERT INTO tg_channel_notify_links (user_id, channel_chat_id, joined_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(user_id, channel_chat_id) DO NOTHING
      `),
      isLinked: db.prepare(`
        SELECT COUNT(*) AS n
        FROM tg_channel_notify_links
        WHERE user_id = ? AND channel_chat_id = ?
      `),
      listForChannel: db.prepare(`
        SELECT user_id
        FROM tg_channel_notify_links
        WHERE channel_chat_id = ?
        ORDER BY user_id ASC
      `),
      listForUser: db.prepare(`
        SELECT channel_chat_id
        FROM tg_channel_notify_links
        WHERE user_id = ?
        ORDER BY channel_chat_id ASC
      `),
      removeUserFromChannel: db.prepare(`
        DELETE FROM tg_channel_notify_links
        WHERE user_id = ? AND channel_chat_id = ?
      `),
      removeAllForUser: db.prepare(`
        DELETE FROM tg_channel_notify_links WHERE user_id = ?
      `),
      removeAllForChannel: db.prepare(`
        DELETE FROM tg_channel_notify_links WHERE channel_chat_id = ?
      `),
    }
    return this.statements
  }
}

export const telegramChannelNotifyLinkStore = new TelegramChannelNotifyLinkStore()
