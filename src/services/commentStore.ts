import { v4 as uuidv4 } from 'uuid'
import type Database from 'better-sqlite3'

import { getDb } from '../db/database'
import { logger } from '../utils/logger'

import { postStore } from './postStore'
import { pushAdminActivity } from './adminActivityStore'

export interface CommentReply {
  reply_id?: string
  text: string
  timestamp: string
  /** Display name of the admin who replied (from Mini App). */
  admin_name?: string
  /** Attached image URLs (served by backend). */
  photo_urls?: string[]
}

/** DM to an admin: message id for later edits when the channel replies. */
export interface CommentAdminNotificationMid {
  admin_id: number
  message_mid: string
}

/** One channel reply line shown in the admin DM thread (appended on each answer). */
export interface CommentNotificationReplyLogEntry {
  text: string
  timestamp: string
  replier_name: string
  photo_count?: number
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
  /** Author profile photo (MAX `avatar_url` / `full_avatar_url`). */
  avatar_url?: string
  /** Attached image URLs (served by backend). */
  photo_urls?: string[]
  reply?: CommentReply
  /** All channel replies in order (miniapp thread); {@link reply} mirrors the latest. */
  replies?: CommentReply[]
  /** Original admin-notification body (before «✅ Отвечено» line is appended). */
  notification_text?: string
  /** One entry per admin who received the new-comment DM. */
  notification_mids?: CommentAdminNotificationMid[]
  /** Chronology of channel replies appended to the single admin notification. */
  notification_reply_log?: CommentNotificationReplyLogEntry[]
  /** Mini App: admin posted from composer without «Ответить» — show as channel, not personal profile. */
  posted_as_channel?: boolean
}

function isCommentReply(value: unknown): value is CommentReply {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const o = value as Record<string, unknown>
  if (o.admin_name !== undefined && typeof o.admin_name !== 'string') {
    return false
  }
  if (o.photo_urls !== undefined) {
    if (
      !Array.isArray(o.photo_urls) ||
      o.photo_urls.some((u) => typeof u !== 'string' || !u.trim())
    ) {
      return false
    }
  }
  if (o.reply_id !== undefined && typeof o.reply_id !== 'string') {
    return false
  }
  return typeof o.text === 'string' && typeof o.timestamp === 'string'
}

function ensureCommentReplyIds(comment: Comment): void {
  const thread = existingRepliesList(comment)
  for (const r of thread) {
    if (!r.reply_id) {
      r.reply_id = uuidv4()
    }
  }
  if (thread.length > 0) {
    setReplies(comment, thread)
  }
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
    (o.reply !== undefined && !isCommentReply(o.reply)) ||
    (o.replies !== undefined &&
      (!Array.isArray(o.replies) || o.replies.some((r) => !isCommentReply(r))))
  ) {
    return null
  }
  if (o.notification_text !== undefined && typeof o.notification_text !== 'string') {
    return null
  }
  if (o.avatar_url !== undefined && typeof o.avatar_url !== 'string') {
    return null
  }
  if (o.photo_urls !== undefined) {
    if (!Array.isArray(o.photo_urls)) {
      return null
    }
    for (const url of o.photo_urls) {
      if (typeof url !== 'string' || !url.trim()) {
        return null
      }
    }
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
  if (o.notification_reply_log !== undefined) {
    if (!Array.isArray(o.notification_reply_log)) {
      return null
    }
    for (const row of o.notification_reply_log) {
      if (!isNotificationReplyLogEntry(row)) {
        return null
      }
    }
  }
  if (o.posted_as_channel !== undefined && typeof o.posted_as_channel !== 'boolean') {
    return null
  }
  const comment: Comment = {
    comment_id: o.comment_id,
    post_id: o.post_id,
    user_id: userId,
    username: o.username,
    text: o.text,
    timestamp: o.timestamp,
    ...(typeof o.avatar_url === 'string' && o.avatar_url.trim()
      ? { avatar_url: o.avatar_url.trim() }
      : {}),
    ...(Array.isArray(o.photo_urls) && o.photo_urls.length > 0
      ? {
          photo_urls: o.photo_urls
            .map((u) => String(u).trim())
            .filter(Boolean),
        }
      : {}),
    ...(o.reply !== undefined ? { reply: o.reply as CommentReply } : {}),
    ...(Array.isArray(o.replies) && o.replies.length > 0
      ? { replies: o.replies as CommentReply[] }
      : {}),
    ...(o.notification_text !== undefined
      ? { notification_text: o.notification_text }
      : {}),
    ...(o.notification_mids !== undefined
      ? { notification_mids: o.notification_mids as CommentAdminNotificationMid[] }
      : {}),
    ...(o.notification_reply_log !== undefined
      ? {
          notification_reply_log: o.notification_reply_log as CommentNotificationReplyLogEntry[],
        }
      : {}),
    ...(o.posted_as_channel === true ? { posted_as_channel: true } : {}),
  }
  ensureCommentReplyIds(comment)
  return comment
}

function isNotificationReplyLogEntry(value: unknown): value is CommentNotificationReplyLogEntry {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const o = value as Record<string, unknown>
  if (typeof o.text !== 'string' || typeof o.timestamp !== 'string' || typeof o.replier_name !== 'string') {
    return false
  }
  if (o.photo_count !== undefined && typeof o.photo_count !== 'number') {
    return false
  }
  return true
}

function existingRepliesList(c: Comment): CommentReply[] {
  if (Array.isArray(c.replies) && c.replies.length > 0) {
    return [...c.replies]
  }
  return c.reply ? [c.reply] : []
}

function setReplies(c: Comment, list: CommentReply[]): void {
  if (list.length === 0) {
    delete c.replies
    delete c.reply
    return
  }
  c.replies = list
  c.reply = list[list.length - 1]
}

export function replyToNotificationLogEntry(
  reply: CommentReply,
  notificationReplierName?: string,
): CommentNotificationReplyLogEntry {
  const photoCount = Array.isArray(reply.photo_urls) ? reply.photo_urls.length : 0
  const replier =
    notificationReplierName?.trim() || reply.admin_name?.trim() || 'Канал'
  return {
    text: reply.text,
    timestamp: reply.timestamp,
    replier_name: replier,
    ...(photoCount > 0 ? { photo_count: photoCount } : {}),
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
    const out: Comment[] = []
    for (const row of rows) {
      try {
        const c = this.parseRow(row.data)
        const normalized = normalizeCommentFromDisk(c)
        if (normalized) {
          out.push(normalized)
        } else {
          logger.warn('commentStore: skip corrupt comment row', { postId })
        }
      } catch (err: unknown) {
        logger.warn('commentStore: skip unreadable comment row', { postId, err })
      }
    }
    return out
  }

  /**
   * Attaches a channel reply to a comment. Returns updated comment or `null`.
   * @param replyAdminName optional display name of the replying admin (non-empty trimmed string is stored).
   */
  addReply(
    commentId: string,
    replyText: string,
    replyAdminName?: string,
    replyPhotoUrls?: string[],
    notificationReplierName?: string,
  ): Comment | null {
    const c = this.getComment(commentId)
    if (!c) {
      return null
    }
    const trimmedName = replyAdminName?.trim()
    const reply: CommentReply = {
      reply_id: uuidv4(),
      text: replyText,
      timestamp: new Date().toISOString(),
    }
    if (trimmedName) {
      reply.admin_name = trimmedName
    }
    if (Array.isArray(replyPhotoUrls) && replyPhotoUrls.length > 0) {
      reply.photo_urls = replyPhotoUrls.map((u) => u.trim()).filter(Boolean)
    }
    const thread = existingRepliesList(c)
    thread.push(reply)
    setReplies(c, thread)
    const log = c.notification_reply_log ?? []
    const newEntry = replyToNotificationLogEntry(reply, notificationReplierName)
    const last = log[log.length - 1]
    if (last && last.timestamp === newEntry.timestamp) {
      log[log.length - 1] = newEntry
      c.notification_reply_log = log
    } else {
      c.notification_reply_log = [...log, newEntry]
    }
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

  /** Persists author avatar URL when resolved from MAX API or Mini App. */
  setCommentAvatarUrl(commentId: string, avatarUrl: string): Comment | null {
    const c = this.getComment(commentId)
    if (!c) {
      return null
    }
    const trimmed = avatarUrl.trim()
    if (!trimmed || c.avatar_url === trimmed) {
      return c
    }
    c.avatar_url = trimmed
    this.saveRow(c)
    return c
  }

  /**
   * Updates an existing admin reply (preserves original timestamp). Returns `null` if missing.
   * @param replyPhotoUrls `undefined` — не менять вложения; `[]` — удалить фото; иначе заменить список URL.
   */
  updateReply(
    commentId: string,
    replyText: string,
    replyAdminName?: string,
    replyPhotoUrls?: string[],
  ): Comment | null {
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
    /** `undefined` = не трогать вложения; `[]` = удалить все фото в ответе. */
    if (replyPhotoUrls !== undefined) {
      if (replyPhotoUrls.length > 0) {
        c.reply.photo_urls = replyPhotoUrls.map((u) => u.trim()).filter(Boolean)
      } else {
        delete c.reply.photo_urls
      }
    }
    const thread = existingRepliesList(c)
    if (thread.length > 0) {
      thread[thread.length - 1] = c.reply
      c.replies = thread
    }
    const log = c.notification_reply_log ?? []
    if (log.length > 0) {
      log[log.length - 1] = replyToNotificationLogEntry(c.reply)
      c.notification_reply_log = log
    } else {
      c.notification_reply_log = [replyToNotificationLogEntry(c.reply)]
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
    const thread = c ? existingRepliesList(c) : []
    if (!c || thread.length === 0) {
      return null
    }
    thread.pop()
    setReplies(c, thread)
    const log = c.notification_reply_log ?? []
    if (log.length > 0) {
      log.pop()
      if (log.length > 0) {
        c.notification_reply_log = log
      } else {
        delete c.notification_reply_log
      }
    }
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
    if (!row) {
      return null
    }
    try {
      return normalizeCommentFromDisk(this.parseRow(row.data))
    } catch (err: unknown) {
      logger.warn('commentStore: getComment parse failed', { commentId, err })
      return null
    }
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
    const out: Comment[] = []
    for (const row of rows) {
      try {
        const c = normalizeCommentFromDisk(this.parseRow(row.data))
        if (c) {
          out.push(c)
        }
      } catch {
        // skip corrupt rows
      }
    }
    return out
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

  private parseRow(raw: string): unknown {
    return JSON.parse(raw) as unknown
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
