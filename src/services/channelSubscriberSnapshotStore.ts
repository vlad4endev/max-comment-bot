import type { Bot } from '@maxhub/max-bot-api'
import type { ChatMember } from '@maxhub/max-bot-api/types'
import type Database from 'better-sqlite3'

import { getDb } from '../db/database'
import { channelRegistry } from './channelRegistry'
import { logger } from '../utils/logger'

const PAGE_SIZE = 100
const MAX_PAGES = 500

export interface ChannelSubscriberRow {
  channel_chat_id: number
  user_id: number
  name: string | null
  username: string | null
  avatar_url: string | null
  is_admin: boolean
  is_owner: boolean
  join_time: number | null
  last_activity_time: number | null
  synced_at: string
}

interface ChannelSyncMeta {
  channel_chat_id: number
  last_synced_at: string
  members_total: number
}

function normalizeMemberName(value: string | null | undefined): string | null {
  const t = typeof value === 'string' ? value.trim() : ''
  return t || null
}

function normalizeMemberUsername(value: string | null | undefined): string | null {
  const t = typeof value === 'string' ? value.trim() : ''
  return t || null
}

function normalizeMemberAvatar(value: string | null | undefined): string | null {
  const t = typeof value === 'string' ? value.trim() : ''
  return t || null
}

function mapMember(channelChatId: number, member: ChatMember, syncedAtIso: string): ChannelSubscriberRow {
  return {
    channel_chat_id: channelChatId,
    user_id: member.user_id,
    name: normalizeMemberName(member.name),
    username: normalizeMemberUsername(member.username),
    avatar_url: normalizeMemberAvatar(member.full_avatar_url ?? member.avatar_url),
    is_admin: member.is_admin,
    is_owner: member.is_owner,
    join_time: Number.isFinite(member.join_time) ? member.join_time : null,
    last_activity_time: Number.isFinite(member.last_activity_time) ? member.last_activity_time : null,
    synced_at: syncedAtIso,
  }
}

export class ChannelSubscriberSnapshotStore {
  private statements:
    | {
        deleteByChannel: Database.Statement
        upsertMember: Database.Statement
        upsertSyncMeta: Database.Statement
        listAllMembers: Database.Statement
        listMembersForUser: Database.Statement
      }
    | null = null

  async syncChannelSubscribers(bot: Bot, channelChatId: number): Promise<{ members_total: number }> {
    const byUser = new Map<number, ChannelSubscriberRow>()
    let marker: number | undefined
    const syncedAtIso = new Date().toISOString()

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await bot.api.getChatMembers(channelChatId, {
        count: PAGE_SIZE,
        ...(marker !== undefined ? { marker } : {}),
      })
      for (const member of res.members) {
        if (member.is_bot) {
          continue
        }
        byUser.set(member.user_id, mapMember(channelChatId, member, syncedAtIso))
      }
      const next = res.marker
      if (next === undefined || next === null) {
        break
      }
      marker = next
    }

    const tx = getDb().transaction((rows: ChannelSubscriberRow[], membersTotal: number, syncedAt: string) => {
      const s = this.getStatements()
      s.deleteByChannel.run(channelChatId)
      for (const row of rows) {
        s.upsertMember.run(
          row.channel_chat_id,
          row.user_id,
          row.name,
          row.username,
          row.avatar_url,
          row.is_admin ? 1 : 0,
          row.is_owner ? 1 : 0,
          row.join_time,
          row.last_activity_time,
          syncedAt,
        )
      }
      s.upsertSyncMeta.run(channelChatId, syncedAt, membersTotal)
    })

    tx([...byUser.values()], byUser.size, syncedAtIso)
    return { members_total: byUser.size }
  }

  async syncAllRegisteredChannels(bot: Bot): Promise<{
    synced_channels: number
    failed_channels: number
    members_total: number
    channels: Array<{ chat_id: number; title: string | null; members_total: number; ok: boolean; error?: string }>
  }> {
    const channels = channelRegistry.getAllChannels().filter((c) => c.type === 'channel')
    const out: Array<{ chat_id: number; title: string | null; members_total: number; ok: boolean; error?: string }> = []
    let synced = 0
    let failed = 0
    let membersTotal = 0

    for (const ch of channels) {
      try {
        const r = await this.syncChannelSubscribers(bot, ch.chat_id)
        synced += 1
        membersTotal += r.members_total
        out.push({ chat_id: ch.chat_id, title: ch.title, members_total: r.members_total, ok: true })
      } catch (err: unknown) {
        failed += 1
        const message = err instanceof Error ? err.message : 'failed to sync'
        logger.warn('channelSubscriberSnapshotStore: channel sync failed', {
          chatId: ch.chat_id,
          err,
        })
        out.push({
          chat_id: ch.chat_id,
          title: ch.title,
          members_total: 0,
          ok: false,
          error: message,
        })
      }
    }

    return {
      synced_channels: synced,
      failed_channels: failed,
      members_total: membersTotal,
      channels: out,
    }
  }

  listAllMembers(): ChannelSubscriberRow[] {
    const rows = this.getStatements().listAllMembers.all() as Array<{
      channel_chat_id: number
      user_id: number
      name: string | null
      username: string | null
      avatar_url: string | null
      is_admin: number
      is_owner: number
      join_time: number | null
      last_activity_time: number | null
      synced_at: string
    }>
    return rows.map((row) => ({
      channel_chat_id: row.channel_chat_id,
      user_id: row.user_id,
      name: row.name,
      username: row.username,
      avatar_url: row.avatar_url,
      is_admin: row.is_admin === 1,
      is_owner: row.is_owner === 1,
      join_time: row.join_time,
      last_activity_time: row.last_activity_time,
      synced_at: row.synced_at,
    }))
  }

  listMembersForUser(userId: number): ChannelSubscriberRow[] {
    const rows = this.getStatements().listMembersForUser.all(userId) as Array<{
      channel_chat_id: number
      user_id: number
      name: string | null
      username: string | null
      avatar_url: string | null
      is_admin: number
      is_owner: number
      join_time: number | null
      last_activity_time: number | null
      synced_at: string
    }>
    return rows.map((row) => ({
      channel_chat_id: row.channel_chat_id,
      user_id: row.user_id,
      name: row.name,
      username: row.username,
      avatar_url: row.avatar_url,
      is_admin: row.is_admin === 1,
      is_owner: row.is_owner === 1,
      join_time: row.join_time,
      last_activity_time: row.last_activity_time,
      synced_at: row.synced_at,
    }))
  }

  listChannelSyncMeta(): ChannelSyncMeta[] {
    const db = getDb()
    const rows = db
      .prepare(
        `SELECT channel_chat_id, last_synced_at, members_total
         FROM channel_subscribers_sync
         ORDER BY channel_chat_id ASC`,
      )
      .all() as ChannelSyncMeta[]
    return rows
  }

  private getStatements(): NonNullable<ChannelSubscriberSnapshotStore['statements']> {
    if (this.statements) {
      return this.statements
    }
    const db = getDb()
    this.statements = {
      deleteByChannel: db.prepare('DELETE FROM channel_subscribers WHERE channel_chat_id = ?'),
      upsertMember: db.prepare(`
        INSERT OR REPLACE INTO channel_subscribers (
          channel_chat_id,
          user_id,
          name,
          username,
          avatar_url,
          is_admin,
          is_owner,
          join_time,
          last_activity_time,
          synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      upsertSyncMeta: db.prepare(`
        INSERT OR REPLACE INTO channel_subscribers_sync (
          channel_chat_id,
          last_synced_at,
          members_total
        ) VALUES (?, ?, ?)
      `),
      listAllMembers: db.prepare(`
        SELECT
          channel_chat_id,
          user_id,
          name,
          username,
          avatar_url,
          is_admin,
          is_owner,
          join_time,
          last_activity_time,
          synced_at
        FROM channel_subscribers
        ORDER BY user_id ASC, channel_chat_id ASC
      `),
      listMembersForUser: db.prepare(`
        SELECT
          channel_chat_id,
          user_id,
          name,
          username,
          avatar_url,
          is_admin,
          is_owner,
          join_time,
          last_activity_time,
          synced_at
        FROM channel_subscribers
        WHERE user_id = ?
        ORDER BY channel_chat_id ASC
      `),
    }
    return this.statements
  }
}

export const channelSubscriberSnapshotStore = new ChannelSubscriberSnapshotStore()
