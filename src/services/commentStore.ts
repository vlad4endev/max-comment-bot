import { v4 as uuidv4 } from 'uuid'
import type Database from 'better-sqlite3'

import { getDb } from '../db/database'
import { logger } from '../utils/logger'

import { postStore } from './postStore'
import { pushAdminActivity } from './adminActivityStore'

export interface CommentReply {
  text: string
  timestamp: string
  /** Display name of the admin who replied (from Mini App). */
  admin_name?: string
}

/** DM to an admin: message id for later edits when the channel replies. */
export interface CommentAdminNotificationMid {
  admin_id: number
  message_mid: string
}

/**
 * Persisted comment for a post (Mini App + API).
 */
export interface Comment {
  comment_id: string
  post_id: string
  user_id: number
  username: string
  text: string
  timestamp: string
  reply?: CommentReply
  /** Original admin-notification body (before «✅ Отвечено» line is appended). */
  notification_text?: string
  /** One entry per admin who received the new-comment DM. */
  notification_mids?: CommentAdminNotificationMid[]
}

function isCommentReply(value: unknown): value is CommentReply {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const o = value as Record<string, unknown>
  if (o.admin_name !== undefined && typeof o.admin_name !== 'string') {
    return false
  }
  return typeof o.text === 'string' && typeof o.timestamp === 'string'
}

function parseStoredUserId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number.parseInt(value, 10)
    if (Number.isInteger(n) && n > 0) {
      return n
    }
  }
  return null
}

function isCommentAdminNotificationMid(value: unknown): value is CommentAdminNotificationMid {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const o = value as Record<string, unknown>
  return (
    typeof o.admin_id === 'number' &&
    Number.isInteger(o.admin_id) &&
    typeof o.message_mid === 'string'
  )
}

function normalizeCommentFromDisk(raw: unknown): Comment | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const o = raw as Record<string, unknown>
  const userId = parseStoredUserId(o.user_id)
  if (
    userId === null ||
    typeof o.comment_id !== 'string' ||
    typeof o.post_id !== 'string' ||
    typeof o.username !== 'string' ||
    typeof o.text !== 'string' ||
    typeof o.timestamp !== 'string' ||
    (o.reply !== undefined && !isCommentReply(o.reply))
  ) {
    return null
  }
  if (o.notification_text !== undefined && typeof o.notification_text !== 'string') {
    return null
  }
  if (o.notification_mids !== undefined) {
    if (!Array.isArray(o.notification_mids)) {
      return null
    }
    for (const row of o.notification_mids) {
      if (!isCommentAdminNotificationMid(row)) {
        return null
      }
    }
  }
  return {
    comment_id: o.comment_id,
    post_id: o.post_id,
    user_id: userId,
    username: o.username,
    text: o.text,
    timestamp: o.timestamp,
    ...(o.reply !== undefined ? { reply: o.reply as CommentReply } : {}),
    ...(o.notification_text !== undefined
      ? { notification_text: o.notification_text }
      : {}),
    ...(o.notification_mids !== undefined
      ? { notification_mids: o.notification_mids as CommentAdminNotificationMid[] }
      : {}),
  }
}

export class CommentStore {
  private statements: {
    getById: Database.Statement
    listByPost: Database.Statement
    listAllNewest: Database.Statement
    upsert: Database.Statement
    deleteById: Database.Statement
    deleteAll: Database.Statement
    countAll: Database.Statement
  } | null = null

  async loadFromDisk(): Promise<void> {
    logger.debug('commentStore: SQLite backend active, loadFromDisk noop')
  }

  saveComment(input: Omit<Comment, 'comment_id' | 'timestamp'>): Comment {
    const comment: Comment = {
      ...input,
      comment_id: uuidv4(),
      timestamp: new Date().toISOString(),
    }
    this.saveRow(comment)
    logger.info(`commentStore: saved ${comment.comment_id}`)
    const post = postStore.getPost(comment.post_id)
    pushAdminActivity('new_comment', {
      comment_id: comment.comment_id,
      post_id: comment.post_id,
      user_id: comment.user_id,
      ...(post ? { chat_id: post.chat_id } : {}),
    })
    return comment
  }

  getComments(postId: string): Comment[] {
    const rows = this.getStatements().listByPost.all(postId) as { data: string }[]
    return rows.map((row) => this.parseRow(row.data))
  }

  /**
   * Attaches a channel reply to a comment. Returns updated comment or `null`.
   * @param replyAdminName optional display name of the replying admin (non-empty trimmed string is stored).
   */
  addReply(commentId: string, replyText: string, replyAdminName?: string): Comment | null {
    const c = this.getComment(commentId)
    if (!c) {
      return null
    }
    const trimmedName = replyAdminName?.trim()
    const reply: CommentReply = { text: replyText, timestamp: new Date().toISOString() }
    if (trimmedName) {
      reply.admin_name = trimmedName
    }
    c.reply = reply
    this.saveRow(c)
    logger.info(`commentStore: reply on ${commentId}`)
    const post = postStore.getPost(c.post_id)
    pushAdminActivity('admin_reply', {
      comment_id: commentId,
      post_id: c.post_id,
      ...(post ? { chat_id: post.chat_id } : {}),
    })
    return c
  }

  /**
   * Updates comment body text. Returns updated comment or `null`.
   */
  updateCommentText(commentId: string, text: string): Comment | null {
    const c = this.getComment(commentId)
    if (!c) {
      return null
    }
    c.text = text
    this.saveRow(c)
    logger.info(`commentStore: updated text ${commentId}`)
    return c
  }

  /**
   * Updates an existing admin reply (preserves original timestamp). Returns `null` if missing.
   */
  updateReply(commentId: string, replyText: string, replyAdminName?: string): Comment | null {
    const c = this.getComment(commentId)
    if (!c?.reply) {
      return null
    }
    c.reply.text = replyText
    const trimmedName = replyAdminName?.trim()
    if (trimmedName) {
      c.reply.admin_name = trimmedName
    } else {
      delete c.reply.admin_name
    }
    this.saveRow(c)
    logger.info(`commentStore: updated reply ${commentId}`)
    return c
  }

  /**
   * Removes the admin reply from a comment. Returns updated comment or `null`.
   */
  deleteReply(commentId: string): Comment | null {
    const c = this.getComment(commentId)
    if (!c?.reply) {
      return null
    }
    delete c.reply
    this.saveRow(c)
    logger.info(`commentStore: deleted reply ${commentId}`)
    return c
  }

  /**
   * Deletes a comment entirely. Returns removed comment or `null`.
   */
  deleteComment(commentId: string): Comment | null {
    const removed = this.getComment(commentId)
    if (!removed) {
      return null
    }
    this.getStatements().deleteById.run(commentId)
    logger.info(`commentStore: deleted ${commentId}`)
    return removed
  }

  /**
   * Returns a single comment or `null`.
   */
  getComment(commentId: string): Comment | null {
    const row = this.getStatements().getById.get(commentId) as { data: string } | undefined
    return row ? this.parseRow(row.data) : null
  }

  /**
   * Persists the admin DM template text for this comment (used when editing notifications after reply).
   */
  saveNotificationText(commentId: string, text: string): void {
    const c = this.getComment(commentId)
    if (!c) {
      return
    }
    c.notification_text = text
    this.saveRow(c)
  }

  /**
   * Records the DM `message_mid` for one admin (upserts by `admin_id`).
   */
  saveNotificationMid(commentId: string, adminId: number, mid: string): void {
    const c = this.getComment(commentId)
    if (!c) {
      return
    }
    const list = c.notification_mids ?? []
    const idx = list.findIndex((e) => e.admin_id === adminId)
    const entry: CommentAdminNotificationMid = { admin_id: adminId, message_mid: mid }
    if (idx >= 0) {
      list[idx] = entry
    } else {
      list.push(entry)
    }
    c.notification_mids = list
    this.saveRow(c)
  }

  getNotificationMids(commentId: string): CommentAdminNotificationMid[] {
    const c = this.getComment(commentId)
    return c?.notification_mids ? [...c.notification_mids] : []
  }

  /**
   * Counts comments whose posts belong to the given channel (`postIds` from postStore).
   */
  countForPostIds(postIds: Set<string>): number {
    if (postIds.size === 0) {
      return 0
    }
    const ids = [...postIds]
    const placeholders = ids.map(() => '?').join(', ')
    const stmt = getDb().prepare(`SELECT COUNT(*) AS n FROM comments WHERE post_id IN (${placeholders})`)
    const row = stmt.get(...ids) as { n: number }
    return Number(row.n) || 0
  }

  /**
   * All comments, newest first (admin list).
   */
  listAllCommentsNewestFirst(): Comment[] {
    const rows = this.getStatements().listAllNewest.all() as { data: string }[]
    return rows.map((row) => this.parseRow(row.data))
  }

  /**
   * Comments for posts in a channel (`postStore` lookup).
   */
  listCommentsForChannelChatId(chatId: number): Comment[] {
    return this.listAllCommentsNewestFirst().filter((c) => {
      const p = postStore.getPost(c.post_id)
      return p?.chat_id === chatId
    })
  }

  removeCommentsByPostIds(postIds: Set<string>): number {
    if (postIds.size === 0) {
      return 0
    }
    const ids = [...postIds]
    const placeholders = ids.map(() => '?').join(', ')
    const stmt = getDb().prepare(`DELETE FROM comments WHERE post_id IN (${placeholders})`)
    const result = stmt.run(...ids)
    return Number(result.changes) || 0
  }

  /** Очистка comments.json (опасная зона / сброс постов). */
  clearAllComments(): void {
    this.getStatements().deleteAll.run()
    logger.warn('commentStore: clearAllComments')
  }

  /**
   * Total comment count.
   */
  get totalCount(): number {
    const row = this.getStatements().countAll.get() as { n: number }
    return Number(row.n) || 0
  }

  private parseRow(raw: string): Comment {
    return JSON.parse(raw) as Comment
  }

  private saveRow(comment: Comment): void {
    this.getStatements().upsert.run(
      comment.comment_id,
      comment.post_id,
      comment.user_id,
      comment.username,
      comment.text,
      comment.timestamp,
      comment.reply ? JSON.stringify(comment.reply) : null,
      comment.notification_text ?? null,
      comment.notification_mids ? JSON.stringify(comment.notification_mids) : null,
      JSON.stringify(comment),
    )
  }

  private getStatements(): NonNullable<CommentStore['statements']> {
    if (this.statements) {
      return this.statements
    }
    const db = getDb()
    this.statements = {
      getById: db.prepare('SELECT data FROM comments WHERE comment_id = ?'),
      listByPost: db.prepare('SELECT data FROM comments WHERE post_id = ? ORDER BY timestamp ASC'),
      listAllNewest: db.prepare('SELECT data FROM comments ORDER BY timestamp DESC'),
      upsert: db.prepare(
        `INSERT OR REPLACE INTO comments (
          comment_id, post_id, user_id, username, text, timestamp, reply, notification_text, notification_mids, data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      deleteById: db.prepare('DELETE FROM comments WHERE comment_id = ?'),
      deleteAll: db.prepare('DELETE FROM comments'),
      countAll: db.prepare('SELECT COUNT(*) AS n FROM comments'),
    }
    return this.statements
  }
}

export const commentStore = new CommentStore()
