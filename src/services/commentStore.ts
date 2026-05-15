import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { v4 as uuidv4 } from 'uuid'

import { postStore } from './postStore'
import { pushAdminActivity } from './adminActivityStore'
import { logger } from '../utils/logger'

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

interface CommentsFileShape {
  comments: Comment[]
}

const DEFAULT_COMMENTS_PATH = join(process.cwd(), 'data', 'comments.json')

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

/**
 * JSON-backed comment list with async persistence under `data/comments.json`.
 */
export class CommentStore {
  private readonly comments: Comment[] = []
  private readonly filePath: string
  private persistChain: Promise<void> = Promise.resolve()

  constructor(filePath: string = DEFAULT_COMMENTS_PATH) {
    this.filePath = filePath
  }

  /**
   * Loads comments from disk (replaces in-memory list).
   */
  async loadFromDisk(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw) as unknown
      if (typeof parsed !== 'object' || parsed === null || !('comments' in parsed)) {
        logger.warn('commentStore: invalid comments.json shape, starting empty')
        this.comments.length = 0
        return
      }
      const list = (parsed as CommentsFileShape).comments
      if (!Array.isArray(list)) {
        this.comments.length = 0
        return
      }
      this.comments.length = 0
      for (const item of list) {
        const normalized = normalizeCommentFromDisk(item)
        if (normalized) {
          this.comments.push(normalized)
        }
      }
      logger.info(`commentStore: loaded ${this.comments.length} comment(s)`)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        logger.debug('commentStore: comments.json missing, empty store')
        return
      }
      logger.error('commentStore: failed to read comments.json', e)
    }
  }

  /**
   * Appends a new comment (assigns id and ISO timestamp) and persists.
   */
  saveComment(input: Omit<Comment, 'comment_id' | 'timestamp'>): Comment {
    const comment: Comment = {
      ...input,
      comment_id: uuidv4(),
      timestamp: new Date().toISOString(),
    }
    this.comments.push(comment)
    this.queuePersist()
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

  /**
   * Returns comments for a post, oldest first.
   */
  getComments(postId: string): Comment[] {
    return this.comments
      .filter((c) => c.post_id === postId)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  }

  /**
   * Attaches a channel reply to a comment. Returns updated comment or `null`.
   * @param replyAdminName optional display name of the replying admin (non-empty trimmed string is stored).
   */
  addReply(commentId: string, replyText: string, replyAdminName?: string): Comment | null {
    const c = this.comments.find((x) => x.comment_id === commentId)
    if (!c) {
      return null
    }
    const trimmedName = replyAdminName?.trim()
    const reply: CommentReply = { text: replyText, timestamp: new Date().toISOString() }
    if (trimmedName) {
      reply.admin_name = trimmedName
    }
    c.reply = reply
    this.queuePersist()
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
    const c = this.comments.find((x) => x.comment_id === commentId)
    if (!c) {
      return null
    }
    c.text = text
    this.queuePersist()
    logger.info(`commentStore: updated text ${commentId}`)
    return c
  }

  /**
   * Updates an existing admin reply (preserves original timestamp). Returns `null` if missing.
   */
  updateReply(commentId: string, replyText: string, replyAdminName?: string): Comment | null {
    const c = this.comments.find((x) => x.comment_id === commentId)
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
    this.queuePersist()
    logger.info(`commentStore: updated reply ${commentId}`)
    return c
  }

  /**
   * Removes the admin reply from a comment. Returns updated comment or `null`.
   */
  deleteReply(commentId: string): Comment | null {
    const c = this.comments.find((x) => x.comment_id === commentId)
    if (!c?.reply) {
      return null
    }
    delete c.reply
    this.queuePersist()
    logger.info(`commentStore: deleted reply ${commentId}`)
    return c
  }

  /**
   * Deletes a comment entirely. Returns removed comment or `null`.
   */
  deleteComment(commentId: string): Comment | null {
    const idx = this.comments.findIndex((x) => x.comment_id === commentId)
    if (idx < 0) {
      return null
    }
    const [removed] = this.comments.splice(idx, 1)
    this.queuePersist()
    logger.info(`commentStore: deleted ${commentId}`)
    return removed
  }

  /**
   * Returns a single comment or `null`.
   */
  getComment(commentId: string): Comment | null {
    return this.comments.find((c) => c.comment_id === commentId) ?? null
  }

  /**
   * Persists the admin DM template text for this comment (used when editing notifications after reply).
   */
  saveNotificationText(commentId: string, text: string): void {
    const c = this.comments.find((x) => x.comment_id === commentId)
    if (!c) {
      return
    }
    c.notification_text = text
    this.queuePersist()
  }

  /**
   * Records the DM `message_mid` for one admin (upserts by `admin_id`).
   */
  saveNotificationMid(commentId: string, adminId: number, mid: string): void {
    const c = this.comments.find((x) => x.comment_id === commentId)
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
    this.queuePersist()
  }

  getNotificationMids(commentId: string): CommentAdminNotificationMid[] {
    const c = this.comments.find((x) => x.comment_id === commentId)
    return c?.notification_mids ? [...c.notification_mids] : []
  }

  /**
   * Counts comments whose posts belong to the given channel (`postIds` from postStore).
   */
  countForPostIds(postIds: Set<string>): number {
    if (postIds.size === 0) {
      return 0
    }
    return this.comments.filter((c) => postIds.has(c.post_id)).length
  }

  /**
   * All comments, newest first (admin list).
   */
  listAllCommentsNewestFirst(): Comment[] {
    return [...this.comments].sort((a, b) => b.timestamp.localeCompare(a.timestamp))
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
    let removed = 0
    for (let i = this.comments.length - 1; i >= 0; i -= 1) {
      if (postIds.has(this.comments[i]!.post_id)) {
        this.comments.splice(i, 1)
        removed += 1
      }
    }
    if (removed > 0) {
      this.queuePersist()
    }
    return removed
  }

  /** Очистка comments.json (опасная зона / сброс постов). */
  clearAllComments(): void {
    if (this.comments.length === 0) {
      return
    }
    this.comments.length = 0
    this.queuePersist()
    logger.warn('commentStore: clearAllComments')
  }

  /**
   * Total comment count.
   */
  get totalCount(): number {
    return this.comments.length
  }

  private queuePersist(): void {
    this.persistChain = this.persistChain
      .then(() => this.persist())
      .catch((e: unknown) => {
        logger.error('commentStore: persist error', e)
      })
  }

  private async persist(): Promise<void> {
    const dir = dirname(this.filePath)
    await mkdir(dir, { recursive: true })
    const body: CommentsFileShape = { comments: [...this.comments] }
    await writeFile(this.filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  }
}

export const commentStore = new CommentStore()
