import { randomBytes } from 'node:crypto'

import type Database from 'better-sqlite3'

import { getDb } from '../db/database'

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const CHANNEL_LINK_DRAFT_TTL_MS = 15 * 60 * 1000

export type ChannelLinkDraftStatus =
  | 'pending'
  | 'awaiting_max_confirm'
  | 'completed'
  | 'expired'
  | 'cancelled'

export interface ChannelLinkDraftRow {
  code: string
  profile_id: string
  max_chat_id: number
  max_user_id: number
  max_title: string | null
  status: ChannelLinkDraftStatus
  tg_channel_id: string | null
  tg_username: string | null
  tg_user_id: number | null
  chain_id: string | null
  forward_posts: boolean
  add_comments_button: boolean
  created_at: string
  expires_at: string
}

function generateLinkCode(): string {
  const bytes = randomBytes(6)
  let code = ''
  for (let i = 0; i < 6; i += 1) {
    code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length]
  }
  return code
}

function rowFromDb(raw: Record<string, unknown>): ChannelLinkDraftRow {
  return {
    code: String(raw.code),
    profile_id: String(raw.profile_id),
    max_chat_id: Number(raw.max_chat_id),
    max_user_id: Number(raw.max_user_id),
    max_title: typeof raw.max_title === 'string' ? raw.max_title : null,
    status: String(raw.status) as ChannelLinkDraftStatus,
    tg_channel_id: typeof raw.tg_channel_id === 'string' ? raw.tg_channel_id : null,
    tg_username: typeof raw.tg_username === 'string' ? raw.tg_username : null,
    tg_user_id:
      typeof raw.tg_user_id === 'number' && Number.isInteger(raw.tg_user_id) ? raw.tg_user_id : null,
    chain_id: typeof raw.chain_id === 'string' ? raw.chain_id : null,
    forward_posts: raw.forward_posts === 0 ? false : true,
    add_comments_button: raw.add_comments_button === 0 ? false : true,
    created_at: String(raw.created_at),
    expires_at: String(raw.expires_at),
  }
}

export class ChannelLinkDraftStore {
  private statements:
    | {
        insert: Database.Statement
        cancelOpenForMax: Database.Statement
        getByCode: Database.Statement
        markAwaitingMaxConfirm: Database.Statement
        markCompleted: Database.Statement
        expireStale: Database.Statement
      }
    | null = null

  createDraft(input: {
    profileId: string
    maxChatId: number
    maxUserId: number
    maxTitle: string | null
  }): ChannelLinkDraftRow {
    const stmts = this.getStatements()
    stmts.cancelOpenForMax.run(input.maxChatId)
    const expiresAt = new Date(Date.now() + CHANNEL_LINK_DRAFT_TTL_MS).toISOString()
    let code = generateLinkCode()
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        stmts.insert.run(
          code,
          input.profileId,
          input.maxChatId,
          input.maxUserId,
          input.maxTitle,
          expiresAt,
        )
        const row = stmts.getByCode.get(code) as Record<string, unknown> | undefined
        if (row) {
          return rowFromDb(row)
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!msg.includes('UNIQUE constraint')) {
          throw err
        }
        code = generateLinkCode()
      }
    }
    throw new Error('failed to allocate link code')
  }

  getByCode(code: string): ChannelLinkDraftRow | null {
    this.expireStale()
    const normalized = String(code).trim().toUpperCase()
    if (!/^[A-Z0-9]{6}$/.test(normalized)) {
      return null
    }
    const row = this.getStatements().getByCode.get(normalized) as Record<string, unknown> | undefined
    return row ? rowFromDb(row) : null
  }

  markAwaitingMaxConfirm(
    code: string,
    patch: {
      tgChannelId: string
      tgUsername: string
      tgUserId: number
      forwardPosts: boolean
      addCommentsButton: boolean
    },
  ): void {
    this.getStatements().markAwaitingMaxConfirm.run(
      patch.tgChannelId,
      patch.tgUsername,
      patch.tgUserId,
      patch.forwardPosts ? 1 : 0,
      patch.addCommentsButton ? 1 : 0,
      code.trim().toUpperCase(),
    )
  }

  markCompleted(
    code: string,
    patch: { tgChannelId: string; tgUsername: string; tgUserId: number; chainId: string },
  ): void {
    this.getStatements().markCompleted.run(
      patch.tgChannelId,
      patch.tgUsername,
      patch.tgUserId,
      patch.chainId,
      code.trim().toUpperCase(),
    )
  }

  expireStale(): void {
    this.getStatements().expireStale.run()
  }

  private getStatements(): NonNullable<ChannelLinkDraftStore['statements']> {
    if (this.statements) {
      return this.statements
    }
    const db = getDb()
    this.statements = {
      insert: db.prepare(`
        INSERT INTO channel_link_drafts (
          code, profile_id, max_chat_id, max_user_id, max_title, status, expires_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
      `),
      cancelOpenForMax: db.prepare(`
        UPDATE channel_link_drafts
        SET status = 'cancelled'
        WHERE max_chat_id = ? AND status IN ('pending', 'awaiting_max_confirm')
      `),
      getByCode: db.prepare(`
        SELECT code, profile_id, max_chat_id, max_user_id, max_title, status,
               tg_channel_id, tg_username, tg_user_id, chain_id,
               forward_posts, add_comments_button, created_at, expires_at
        FROM channel_link_drafts
        WHERE code = ?
      `),
      markAwaitingMaxConfirm: db.prepare(`
        UPDATE channel_link_drafts
        SET status = 'awaiting_max_confirm',
            tg_channel_id = ?,
            tg_username = ?,
            tg_user_id = ?,
            forward_posts = ?,
            add_comments_button = ?
        WHERE code = ?
      `),
      markCompleted: db.prepare(`
        UPDATE channel_link_drafts
        SET status = 'completed',
            tg_channel_id = ?,
            tg_username = ?,
            tg_user_id = ?,
            chain_id = ?
        WHERE code = ?
      `),
      expireStale: db.prepare(`
        UPDATE channel_link_drafts
        SET status = 'expired'
        WHERE status IN ('pending', 'awaiting_max_confirm')
          AND expires_at < datetime('now')
      `),
    }
    return this.statements
  }
}

export const channelLinkDraftStore = new ChannelLinkDraftStore()
