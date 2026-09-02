import type { Bot } from '@maxhub/max-bot-api'
import { Keyboard } from '@maxhub/max-bot-api'
import type {
  Attachment,
  AttachmentRequest,
  InlineKeyboardAttachmentRequest,
  Message,
} from '@maxhub/max-bot-api/types'
import type Database from 'better-sqlite3'

import { config } from '../config'
import { getDb } from '../db/database'
import { resolveCanonicalChannelChatId } from './resolveChannelChatId'
import {
  compactUuidToStandard,
  encodeMessageMidForStartapp,
} from '../utils/startappPayload'
import {
  formatMaxBookedInTgButtonLabel,
  formatMaxBookedInVkButtonLabel,
} from '../utils/commentSyncFilter'
import { logger } from '../utils/logger'
import { apiCallWithRetry } from '../utils/maxApiRetry'
import { isCommentsBookingActive } from './commentsBookingLock'

export type CommentsBookedBy = 'telegram' | 'max' | 'vk'

/** Placeholder when MAX requires non-empty `text` but the post has no caption. */
export const CHANNEL_POST_EMPTY_TEXT_PLACEHOLDER = '\u00a0'

/** True for empty / whitespace-only / NBSP-only captions (MAX stub text). */
export function isBlankPostText(text: string | undefined | null): boolean {
  return (text ?? '').replace(/\u00a0/g, ' ').trim() === ''
}

/**
 * Picks the first non-blank caption candidate for `editMessage`.
 * Never prefers `\u00a0` / empty over a real caption — that was wiping album descriptions.
 */
export function resolveChannelPostEditText(
  candidates: Array<string | undefined | null>,
): string {
  for (const candidate of candidates) {
    if (!isBlankPostText(candidate)) {
      return (candidate ?? '').replace(/\u00a0/g, ' ').trim()
    }
  }
  return CHANNEL_POST_EMPTY_TEXT_PLACEHOLDER
}

/**
 * True when an `editMessage` with blank/`\u00a0` text would risk clearing a real media caption.
 * Prefer skipping the edit (leave the comment-count button stale) over wiping album text.
 */
export function wouldRiskWipingMediaCaption(
  editText: string | undefined | null,
  post: Post,
  media: AttachmentRequest[],
): boolean {
  if (!isBlankPostText(editText)) {
    return false
  }
  if (media.length > 0) {
    return true
  }
  if (post.photo_url?.trim()) {
    return true
  }
  if (Array.isArray(post.media_attachments) && post.media_attachments.length > 0) {
    return true
  }
  return false
}

/**
 * Channel post tracked for Mini App comments (MAX message id is {@link Post.message_mid}).
 */
export interface Post {
  post_id: string
  chat_id: number
  message_mid: string
  /** If {@link attachCommentButtonToChannelPost} falls back to a reply, edits/updates target this bot message id. */
  comments_ui_message_mid?: string
  /** Display name of the post author, or a placeholder for channel-as-author posts. */
  sender_name?: string
  text: string
  photo_url?: string
  /** Public MAX link to the channel post (`Message.url` from API). */
  channel_post_url?: string
  /**
   * Non-keyboard attachments from the channel post (from {@link Message.body.attachments}).
   * Used so {@link Bot.api.editMessage} can merge media with the inline keyboard instead of replacing all attachments.
   */
  media_attachments?: AttachmentRequest[]
  comment_count: number
  timestamp: string
  /**
   * True when the post row exists but MAX still has no working «Комментарии» button
   * (attach failed). Poller and retry queue keep trying until cleared.
   */
  button_attach_pending?: boolean
  /** Кросс-платформенная бронь поста: кто первым синхронизировал комментарий. */
  comments_booked_by?: CommentsBookedBy
  /** ISO-время захвата брони; от него отсчитывается TTL закрытия комментариев в MAX. */
  comments_booked_at?: string
  /** ID служебного сообщения «Забронировано в МАКСе» в TG-треде (legacy). */
  tg_booked_marker_msg_id?: number
  /** Маркер «Забронировано в МАКСе» дописан в текст TG-поста. */
  tg_booked_in_max_applied?: boolean
  /** ID поста в TG-канале (пересылка TG→MAX). */
  tg_msg_id?: number
  /** ID TG-канала (-100…), источник пересылки. */
  tg_channel_id?: string
}

export class PostStore {
  private statements: {
    getPost: Database.Statement
    listByChatId: Database.Statement
    findByChatAndMid: Database.Statement
    findByAbsChatAndMid: Database.Statement
    findByCommentsUiMid: Database.Statement
    findByMid: Database.Statement
    findByCommentsUiMidAnyChat: Database.Statement
    upsert: Database.Statement
    deleteByChatId: Database.Statement
    selectIdsByChatId: Database.Statement
    deleteAll: Database.Statement
    countAll: Database.Statement
    countByChatId: Database.Statement
  } | null = null

  async loadFromDisk(): Promise<void> {
    logger.debug('postStore: SQLite backend active, loadFromDisk noop')
  }

  savePost(post: Post): void {
    try {
      this.ensureChannelRow(post.chat_id)
      const merged = this.mergeWithExistingPost(post)
      const result = this.getStatements().upsert.run(
        merged.post_id,
        merged.chat_id,
        merged.message_mid,
        merged.comments_ui_message_mid ?? null,
        merged.sender_name ?? null,
        merged.text,
        merged.photo_url ?? null,
        merged.media_attachments ? JSON.stringify(merged.media_attachments) : null,
        merged.comment_count,
        merged.timestamp,
        JSON.stringify(merged),
      )
      const isNew = result.changes > 0 && result.lastInsertRowid !== undefined
      logger.info(isNew ? 'db: пост сохранён' : 'db: пост обновлён', {
        postId: merged.post_id,
        chatId: merged.chat_id,
        messageMid: merged.message_mid,
        pending: merged.button_attach_pending ?? false,
        bookedBy: merged.comments_booked_by ?? null,
      })
    } catch (err: unknown) {
      logger.error('db: ошибка сохранения поста', {
        postId: post.post_id,
        chatId: post.chat_id,
        messageMid: post.message_mid,
        err,
      })
      throw err
    }
  }

  /**
   * Ensures a placeholder row exists in `channels` so FK constraint never blocks post save.
   * Real channel data is managed by channelRegistry; this is a safety net only.
   */
  private ensureChannelRow(chatId: number): void {
    try {
      const r = getDb().prepare(
        "INSERT OR IGNORE INTO channels (chat_id, title, type, date_added, active) VALUES (?, NULL, 'channel', datetime('now'), 1)",
      ).run(chatId)
      if (r.changes > 0) {
        logger.warn('db: канал не найден при сохранении поста — создана заглушка', { chatId })
      }
    } catch (err: unknown) {
      // non-fatal — the main upsert will surface any real constraint error
      logger.warn('db: ensureChannelRow failed', { chatId, err })
    }
  }

  getPost(postId: string): Post | null {
    const id = postId.trim()
    if (!id) {
      return null
    }
    let row = this.getStatements().getPost.get(id) as { data: string } | undefined
    if (!row) {
      const lower = id.toLowerCase()
      if (lower !== id) {
        row = this.getStatements().getPost.get(lower) as { data: string } | undefined
      }
    }
    return row ? this.parsePost(row.data) : null
  }

  /**
   * Resolves a post by UUID, compact UUID, `message_mid`, or `chat_id` + `message_mid`.
   */
  findPost(identifier: string, chatId?: number, options?: { logNotFound?: boolean }): Post | null {
    const id = identifier.trim()
    if (!id) {
      return null
    }

    let post = this.getPost(id)
    if (post) {
      return post
    }

    const fromCompact = compactUuidToStandard(id)
    if (fromCompact && fromCompact !== id) {
      post = this.getPost(fromCompact)
      if (post) {
        return post
      }
    }

    if (chatId !== undefined) {
      post = this.findPostByChannelMessage(chatId, id)
      if (post) {
        return post
      }
      post = this.findPostByCommentsUiMessage(chatId, id)
      if (post) {
        return post
      }
    }

    post = this.findByMessageMid(id)
    if (post) {
      return post
    }

    post = this.findByCommentsUiMessageMid(id)
    if (post) {
      return post
    }

    if (options?.logNotFound !== false) {
      logger.warn('findPost: not found', { identifier: id, chatId })
    }
    return null
  }

  findByMessageMid(messageMid: string): Post | null {
    const mid = messageMid.trim()
    if (!mid) {
      return null
    }
    const row = this.getStatements().findByMid.get(mid) as { data: string } | undefined
    return row ? this.parsePost(row.data) : null
  }

  findByCommentsUiMessageMid(commentsUiMid: string): Post | null {
    const mid = commentsUiMid.trim()
    if (!mid) {
      return null
    }
    const row = this.getStatements().findByCommentsUiMidAnyChat.get(mid) as
      | { data: string }
      | undefined
    return row ? this.parsePost(row.data) : null
  }

  getPostsByChatId(chatId: number): Post[] {
    const rows = this.getStatements().listByChatId.all(chatId) as { data: string }[]
    const out: Post[] = []
    for (const row of rows) {
      const post = this.parsePost(row.data)
      if (post) {
        out.push(post)
      }
    }
    return out
  }

  findPostByChannelMessage(chatId: number, messageMid: string): Post | null {
    const canonical = resolveCanonicalChannelChatId(chatId) ?? chatId
    for (const cid of [canonical, chatId]) {
      const row = this.getStatements().findByChatAndMid.get(cid, messageMid) as
        | { data: string }
        | undefined
      if (row) {
        return this.parsePost(row.data)
      }
    }
    const abs = Math.abs(canonical)
    const absRow = this.getStatements().findByAbsChatAndMid.get(abs, messageMid) as
      | { data: string }
      | undefined
    return absRow ? this.parsePost(absRow.data) : null
  }

  /** Reply-stub message id when edit on the original post failed and the bot sent a threaded keyboard. */
  findPostByCommentsUiMessage(chatId: number, commentsUiMid: string): Post | null {
    const canonical = resolveCanonicalChannelChatId(chatId) ?? chatId
    for (const cid of [canonical, chatId]) {
      const row = this.getStatements().findByCommentsUiMid.get(cid, commentsUiMid) as
        | { data: string }
        | undefined
      if (row) {
        return this.parsePost(row.data)
      }
    }
    return null
  }

  incrementCommentCount(postId: string): number | null {
    const post = this.getPost(postId)
    if (!post) {
      return null
    }
    const actual = this.countCommentsInDb(postId)
    const next: Post = { ...post, comment_count: actual }
    this.savePost(next)
    return next.comment_count
  }

  decrementCommentCount(postId: string): number | null {
    const post = this.getPost(postId)
    if (!post) {
      return null
    }
    const actual = this.countCommentsInDb(postId)
    const next: Post = { ...post, comment_count: actual }
    this.savePost(next)
    return next.comment_count
  }

  /**
   * Aligns {@link Post.comment_count} with rows in `comments` (source of truth).
   * Fixes drift after migration or upsert that reset the cached counter.
   */
  reconcileCommentCount(postId: string): number | null {
    const post = this.getPost(postId)
    if (!post) {
      return null
    }
    const actual = this.countCommentsInDb(postId)
    if (actual !== post.comment_count) {
      logger.info('postStore: reconciled comment_count', {
        postId,
        was: post.comment_count,
        now: actual,
      })
      this.savePost({ ...post, comment_count: actual })
    }
    return actual
  }

  private countCommentsInDb(postId: string): number {
    const row = getDb()
      .prepare('SELECT COUNT(*) AS n FROM comments WHERE post_id = ?')
      .get(postId) as { n: number }
    return Number(row.n) || 0
  }

  removePostsForChatId(chatId: number): string[] {
    const rows = this.getStatements().selectIdsByChatId.all(chatId) as { post_id: string }[]
    if (rows.length === 0) {
      return []
    }
    this.getStatements().deleteByChatId.run(chatId)
    logger.info('db: посты канала удалены', { chatId, count: rows.length })
    return rows.map((row) => row.post_id)
  }

  clearAllPosts(): void {
    this.getStatements().deleteAll.run()
    logger.warn('postStore: clearAllPosts')
  }

  /** Removes a single post row (rollback after failed TG→MAX comment gate). */
  deletePostById(postId: string): void {
    const id = postId.trim()
    if (!id) {
      return
    }
    const r = getDb().prepare('DELETE FROM posts WHERE post_id = ?').run(id)
    if (r.changes > 0) {
      logger.info('db: пост удалён', { postId: id })
    }
  }

  getTotalPostCount(): number {
    const row = this.getStatements().countAll.get() as { n: number }
    return Number(row.n) || 0
  }

  countPostsByChatId(chatId: number): number {
    const row = this.getStatements().countByChatId.get(chatId) as { n: number }
    return Number(row.n) || 0
  }

  /**
   * Атомарно (на уровне строки поста) выставляет бронь, если ещё не занята.
   * @returns true если бронь успешно захвачена
   */
  tryClaimCommentsBooking(postId: string, by: CommentsBookedBy): boolean {
    const post = this.getPost(postId)
    if (!post || post.comments_booked_by) {
      return false
    }
    const comments_booked_at = new Date().toISOString()
    this.savePost({ ...post, comments_booked_by: by, comments_booked_at })
    logger.info('postStore: comments booking claimed', {
      postId,
      bookedBy: by,
      bookedAt: comments_booked_at,
    })
    return true
  }

  setTgBookedMarkerMsgId(postId: string, msgId: number): void {
    const post = this.getPost(postId)
    if (!post) {
      return
    }
    this.savePost({ ...post, tg_booked_marker_msg_id: msgId })
  }

  markTgBookedInMaxApplied(postId: string): void {
    const post = this.getPost(postId)
    if (!post) {
      return
    }
    this.savePost({ ...post, tg_booked_in_max_applied: true })
  }

  /**
   * Updates the channel message inline keyboard to show the current comment count.
   */
  async updateButtonCaption(bot: Bot, post: Post): Promise<boolean> {
    this.reconcileCommentCount(post.post_id)
    const fresh = this.getPost(post.post_id) ?? post
    const closedInMax = isPostCommentsClosedInMax(fresh)
    const bookedByTelegram = closedInMax && fresh.comments_booked_by === 'telegram'
    const bookedByVk = closedInMax && fresh.comments_booked_by === 'vk'
    if (!isMiniAppOpenUrlConfigured()) {
      logger.warn('postStore.updateButtonCaption: BOT_NICKNAME / MINI_APP_URL not usable for links')
      return false
    }
    const url = buildCommentMiniAppUrl(fresh.post_id, fresh.chat_id, fresh.message_mid)
    const startParam = (() => {
      try {
        return new URL(url).searchParams.get('startapp')
      } catch {
        return null
      }
    })()
    logger.info(
      bookedByTelegram
        ? 'commentButton: booked-by-TG button'
        : bookedByVk
          ? 'commentButton: booked-by-VK button'
          : 'commentButton: creating button',
      {
        postId: fresh.post_id,
        chatId: fresh.chat_id,
        messageMid: fresh.message_mid,
        commentCount: fresh.comment_count,
        buttonUrl: url,
        startParam,
        bookedBy: fresh.comments_booked_by ?? null,
        bookingActive: closedInMax,
      },
    )
    const kb = buildPostCommentKeyboard(fresh)
    const targetMid = fresh.comments_ui_message_mid ?? fresh.message_mid
    const usesReplyUi = fresh.comments_ui_message_mid !== undefined
    const editText = usesReplyUi
      ? CHANNEL_POST_EMPTY_TEXT_PLACEHOLDER
      : await resolveSafeChannelPostEditText(bot, fresh, fresh.text, {
          postId: fresh.post_id,
          chatId: fresh.chat_id,
          messageMid: fresh.message_mid,
          source: 'caption_update',
        })
    if (!usesReplyUi && !isBlankPostText(editText) && isBlankPostText(fresh.text)) {
      this.savePost({ ...fresh, text: editText })
      fresh.text = editText
    }
    const { media, warnMissingSnapshot } = usesReplyUi
      ? { media: [] as AttachmentRequest[], warnMissingSnapshot: false }
      : await resolveChannelPostMediaForEdit(bot, fresh)

    // Caption unknown + media: never editMessage with `\u00a0` — that clears album text and keeps photos.
    if (!usesReplyUi && wouldRiskWipingMediaCaption(editText, fresh, media)) {
      logger.warn(
        'postStore.updateButtonCaption: skip edit — caption unknown, refuse to wipe media post',
        {
          postId: fresh.post_id,
          chatId: fresh.chat_id,
          messageMid: fresh.message_mid,
          mediaCount: media.length,
          hasPhotoUrl: Boolean(fresh.photo_url?.trim()),
        },
      )
      return false
    }

    const tryAttachFallback = async (reason: string, keyboard = kb): Promise<boolean> => {
      logger.info('postStore.updateButtonCaption: fallback attach', {
        postId: fresh.post_id,
        reason,
      })
      return attachCommentButtonToChannelPost(bot, fresh, editText, keyboard, {
        source: 'caption_update',
        inlineOnly: false,
      })
    }

    if (!usesReplyUi && warnMissingSnapshot && !postLooksTextOnly(fresh)) {
      return tryAttachFallback('no_media_snapshot')
    }
    if (!usesReplyUi && media.length > 0 && !canMergeKeyboardWithMedia(media.length)) {
      return tryAttachFallback('too_many_media')
    }
    const attachments: AttachmentRequest[] =
      usesReplyUi || media.length === 0 ? [kb] : [...media, kb]
    try {
      await apiCallWithRetry(() =>
        bot.api.editMessage(targetMid, { text: editText, attachments }),
      )
      return true
    } catch (err: unknown) {
      logger.warn('postStore.updateButtonCaption: editMessage failed', {
        postId: fresh.post_id,
        targetMid,
        err,
      })
      return tryAttachFallback('edit_failed')
    }
  }

  /** Сохраняет поля брони при частичных обновлениях поста. */
  private mergeWithExistingPost(post: Post): Post {
    const byId = this.getPost(post.post_id)
    const byMid = this.findPostByChannelMessage(post.chat_id, post.message_mid)
    const existing = byId ?? (byMid && byMid.post_id === post.post_id ? byMid : null)
    if (!existing) {
      return post
    }
    // Never let a blank/NBSP snapshot overwrite a real caption (getMessage race after publish).
    const text =
      isBlankPostText(post.text) && !isBlankPostText(existing.text) ? existing.text : post.text
    return {
      ...existing,
      ...post,
      text,
      comment_count: Math.max(existing.comment_count ?? 0, post.comment_count ?? 0),
      comments_booked_by: post.comments_booked_by ?? existing.comments_booked_by,
      comments_booked_at: post.comments_booked_at ?? existing.comments_booked_at,
      tg_booked_marker_msg_id: post.tg_booked_marker_msg_id ?? existing.tg_booked_marker_msg_id,
      tg_booked_in_max_applied:
        post.tg_booked_in_max_applied === true
          ? true
          : existing.tg_booked_in_max_applied,
    }
  }

  private parsePost(raw: string): Post | null {
    try {
      return JSON.parse(raw) as Post
    } catch (err: unknown) {
      logger.warn('postStore: corrupt posts.data row skipped', {
        err: err instanceof Error ? err.message : String(err),
        preview: raw.slice(0, 80),
      })
      return null
    }
  }

  private getStatements(): NonNullable<PostStore['statements']> {
    if (this.statements) {
      return this.statements
    }
    const db = getDb()
    this.statements = {
      getPost: db.prepare('SELECT data FROM posts WHERE post_id = ?'),
      listByChatId: db.prepare(
        'SELECT data FROM posts WHERE chat_id = ? ORDER BY timestamp ASC, post_id ASC',
      ),
      findByChatAndMid: db.prepare('SELECT data FROM posts WHERE chat_id = ? AND message_mid = ?'),
      findByAbsChatAndMid: db.prepare(
        'SELECT data FROM posts WHERE ABS(chat_id) = ? AND message_mid = ? LIMIT 1',
      ),
      findByCommentsUiMid: db.prepare(
        'SELECT data FROM posts WHERE chat_id = ? AND comments_ui_message_mid = ? LIMIT 1',
      ),
      findByMid: db.prepare(
        'SELECT data FROM posts WHERE message_mid = ? ORDER BY timestamp DESC, post_id DESC LIMIT 1',
      ),
      findByCommentsUiMidAnyChat: db.prepare(
        'SELECT data FROM posts WHERE comments_ui_message_mid = ? ORDER BY timestamp DESC, post_id DESC LIMIT 1',
      ),
      upsert: db.prepare(
        `INSERT INTO posts (
          post_id, chat_id, message_mid, comments_ui_message_mid, sender_name, text,
          photo_url, media_attachments, comment_count, timestamp, data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id, message_mid) DO UPDATE SET
          comments_ui_message_mid = excluded.comments_ui_message_mid,
          sender_name             = excluded.sender_name,
          text                    = excluded.text,
          photo_url               = excluded.photo_url,
          media_attachments       = excluded.media_attachments,
          comment_count           = MAX(posts.comment_count, excluded.comment_count),
          data                    = json_set(
            json_set(
              json_set(
                json_set(excluded.data, '$.post_id', posts.post_id),
                '$.chat_id',
                posts.chat_id
              ),
              '$.message_mid',
              posts.message_mid
            ),
            '$.comment_count',
            MAX(posts.comment_count, excluded.comment_count)
          )`,
      ),
      selectIdsByChatId: db.prepare('SELECT post_id FROM posts WHERE chat_id = ?'),
      deleteByChatId: db.prepare('DELETE FROM posts WHERE chat_id = ?'),
      deleteAll: db.prepare('DELETE FROM posts'),
      countAll: db.prepare('SELECT COUNT(*) AS n FROM posts'),
      countByChatId: db.prepare('SELECT COUNT(*) AS n FROM posts WHERE chat_id = ?'),
    }
    return this.statements
  }
}

/** MAX rejects edits when attachments exceed this count (observed: 5 photos + keyboard fails). */
export const MAX_MESSAGE_ATTACHMENTS = 5

/** Min gap between consecutive MAX API writes (edit/reply) to the same channel to avoid 429. */
const ATTACH_THROTTLE_MS = 1_200
const lastAttachAt = new Map<number, number>()

async function throttleChannelAttach(chatId: number): Promise<void> {
  const now = Date.now()
  const last = lastAttachAt.get(chatId) ?? 0
  const wait = ATTACH_THROTTLE_MS - (now - last)
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait))
  }
  lastAttachAt.set(chatId, Date.now())
}

function textOrUndefined(value: string | null | undefined): string | undefined {
  return value == null ? undefined : value
}

async function fetchLiveChannelMessageText(bot: Bot, post: Post): Promise<string | undefined> {
  try {
    const message = await bot.api.getMessage(post.message_mid)
    return textOrUndefined(message.body?.text)
  } catch {
    try {
      const { messages } = await bot.api.getMessages(post.chat_id, {
        message_ids: [post.message_mid],
      })
      return textOrUndefined(messages[0]?.body?.text)
    } catch {
      return undefined
    }
  }
}

/**
 * Resolves text for editing the original channel post.
 * Reloads live message when candidates are blank so a flaky getMessage right after
 * publish cannot clear a caption that was just sent with media.
 */
async function resolveSafeChannelPostEditText(
  bot: Bot,
  post: Post,
  editText: string,
  logBase: Record<string, unknown>,
): Promise<string> {
  let safe = resolveChannelPostEditText([editText, post.text])
  if (!isBlankPostText(safe)) {
    return safe
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 200 * attempt))
    }
    const liveText = await fetchLiveChannelMessageText(bot, post)
    safe = resolveChannelPostEditText([liveText, editText, post.text])
    if (!isBlankPostText(safe)) {
      logger.info('commentButton: recovered live caption before edit', {
        ...logBase,
        attempt: attempt + 1,
        textLen: safe.length,
      })
      return safe
    }
  }

  return CHANNEL_POST_EMPTY_TEXT_PLACEHOLDER
}

/** True when original media plus an inline keyboard fit in one {@link Bot.api.editMessage}. */
export function canMergeKeyboardWithMedia(mediaCount: number): boolean {
  return mediaCount + 1 <= MAX_MESSAGE_ATTACHMENTS
}

/**
 * Non-keyboard parts of {@link Message.body.attachments} for merging into {@link Bot.api.editMessage}.
 * Incoming {@link Attachment} shapes (e.g. image `payload.url` / `token` / `photo_id`) are accepted by the edit API as {@link AttachmentRequest}.
 */
export function mediaAttachmentRequestsFromMessageBody(
  attachments: Attachment[] | null | undefined,
): AttachmentRequest[] {
  if (!attachments?.length) {
    return []
  }
  return attachments
    .filter((att) => att.type !== 'inline_keyboard')
    .map((a) => a as unknown as AttachmentRequest)
}

/** True when the post row has no media hints — keyboard-only edit is preferred over a reply stub. */
function postLooksTextOnly(post: Post): boolean {
  if (post.photo_url?.trim()) {
    return false
  }
  if (Array.isArray(post.media_attachments) && post.media_attachments.length > 0) {
    return false
  }
  return true
}

/**
 * Resolves media to send with `editMessage` on the original channel post: prefers {@link Post.media_attachments},
 * otherwise loads the message via {@link Bot.api.getMessage} or {@link Bot.api.getMessages}.
 *
 * Empty `media_attachments: []` is treated as missing (refetch) — a stale empty snapshot must not
 * suppress live media and pair with a blank caption edit.
 *
 * @returns `warnMissingSnapshot` true only when the live message could not be loaded (fetch failure /
 * missing message). A successfully loaded text-only post (`attachments` empty) is **not** a missing
 * snapshot — keyboard-only `editMessage` is safe and preferred over a reply stub.
 */
async function resolveChannelPostMediaForEdit(
  bot: Bot,
  post: Post,
): Promise<{ media: AttachmentRequest[]; warnMissingSnapshot: boolean }> {
  if (Array.isArray(post.media_attachments) && post.media_attachments.length > 0) {
    return { media: [...post.media_attachments], warnMissingSnapshot: false }
  }
  let original: Message | undefined
  try {
    original = await bot.api.getMessage(post.message_mid)
  } catch {
    try {
      const { messages } = await bot.api.getMessages(post.chat_id, {
        message_ids: [post.message_mid],
      })
      original = messages[0]
    } catch {
      return { media: [], warnMissingSnapshot: true }
    }
  }
  if (!original) {
    return { media: [], warnMissingSnapshot: true }
  }
  const raw = original.body.attachments
  // Text-only / no media: empty attachments are normal — allow keyboard-only edit on the original.
  if (!raw || raw.length === 0) {
    return { media: [], warnMissingSnapshot: false }
  }
  return { media: mediaAttachmentRequestsFromMessageBody(raw), warnMissingSnapshot: false }
}

/**
 * Option A: {@link Bot.api.editMessage} on the original post (`message_id` + body with `attachments`).
 * Option B (fallback): {@link Bot.api.sendMessageToChat} with `link: { type: 'reply', mid }` — bot-owned message with the keyboard, because channel admins' posts are often not editable by the bot.
 */
export async function attachCommentButtonToChannelPost(
  bot: Bot,
  post: Post,
  editText: string,
  keyboard: InlineKeyboardAttachmentRequest,
  logCtx?: { source?: string; phase?: string; inlineOnly?: boolean },
): Promise<boolean> {
  const apiStartedAt = performance.now()
  const logBase = {
    source: logCtx?.source ?? 'unknown',
    phase: logCtx?.phase,
    postId: post.post_id,
    chatId: post.chat_id,
    messageMid: post.message_mid,
  }
  const { media, warnMissingSnapshot } = await resolveChannelPostMediaForEdit(bot, post)
  const mergeMediaInEdit = canMergeKeyboardWithMedia(media.length)
  if (warnMissingSnapshot) {
    logger.warn(
      'commentButton: нет снимка вложений поста — edit только с клавиатурой (медиа может пропасть)',
      logBase,
    )
  }
  if (media.length > 0 && !mergeMediaInEdit) {
    logger.info('commentButton: слишком много медиа для edit — кнопка через reply под постом', {
      ...logBase,
      mediaCount: media.length,
      maxAttachments: MAX_MESSAGE_ATTACHMENTS,
    })
    if (logCtx?.inlineOnly) {
      logger.info('commentButton: inline-only mode, skip reply fallback', {
        ...logBase,
        mediaCount: media.length,
      })
      return false
    }
  }
  const apiDuration = (): { apiDurationMs: number; apiDuration: string } => {
    const apiDurationMs = Math.round(performance.now() - apiStartedAt)
    const apiDuration =
      apiDurationMs >= 1000 ? `${(apiDurationMs / 1000).toFixed(2)} с` : `${apiDurationMs} мс`
    return { apiDurationMs, apiDuration }
  }

  await throttleChannelAttach(post.chat_id)

  const existingUiMid = post.comments_ui_message_mid?.trim()
  if (existingUiMid) {
    logger.info('commentButton: обновляем существующее reply-сообщение с кнопкой', {
      ...logBase,
      commentsUiMessageMid: existingUiMid,
    })
    try {
      const editStartedAt = performance.now()
      await apiCallWithRetry(() =>
        bot.api.editMessage(existingUiMid, {
          text: CHANNEL_POST_EMPTY_TEXT_PLACEHOLDER,
          attachments: [keyboard],
        }),
      )
      const editMs = Math.round(performance.now() - editStartedAt)
      const timing = apiDuration()
      logger.info(`commentButton: кнопка обновлена в reply UI (${timing.apiDuration})`, {
        ...logBase,
        method: 'edit_ui',
        commentsUiMessageMid: existingUiMid,
        editMs,
        ...timing,
      })
      return true
    } catch (err: unknown) {
      logger.warn('commentButton: edit reply UI не удался — не создаём дубликат reply', {
        ...logBase,
        commentsUiMessageMid: existingUiMid,
        ...apiDuration(),
        err,
      })
      return false
    }
  }

  // Skip inline edit only when we could not load the live message AND the post may have media.
  // Text-only posts must still try editMessage with the keyboard (not a separate reply stub).
  const skipInlineForMissingSnapshot =
    Boolean(!existingUiMid && warnMissingSnapshot && !postLooksTextOnly(post))
  if (skipInlineForMissingSnapshot) {
    logger.warn('commentButton: нет live-снимка медиа-поста — пробуем reply fallback (edit небезопасен)', {
      ...logBase,
    })
    if (logCtx?.inlineOnly) {
      logger.info('commentButton: inline-only mode, skip reply fallback without media snapshot', {
        ...logBase,
      })
      return false
    }
  } else if (warnMissingSnapshot && postLooksTextOnly(post)) {
    logger.info('commentButton: нет live-снимка, но пост без медиа — пробуем keyboard-only edit', {
      ...logBase,
    })
  }
  if (!skipInlineForMissingSnapshot && mergeMediaInEdit) {
    const attachments: AttachmentRequest[] =
      media.length > 0 ? [...media, keyboard] : [keyboard]
    const safeEditText = await resolveSafeChannelPostEditText(bot, post, editText, logBase)
    if (!isBlankPostText(safeEditText) && isBlankPostText(post.text)) {
      postStore.savePost({ ...post, text: safeEditText })
      post.text = safeEditText
    }

    // Never rewrite a media post with `\u00a0` — that clears the caption and keeps photos.
    if (wouldRiskWipingMediaCaption(safeEditText, post, media)) {
      logger.warn('commentButton: skip inline edit — caption unknown, refuse to wipe media post', {
        ...logBase,
        mediaCount: media.length,
        hasPhotoUrl: Boolean(post.photo_url?.trim()),
        inlineOnly: Boolean(logCtx?.inlineOnly),
      })
      if (logCtx?.inlineOnly) {
        return false
      }
      // Fall through to reply under the post (does not touch original caption).
    } else {
      logger.info('commentButton: пробуем editMessage на посте канала', {
        ...logBase,
        attachmentCount: attachments.length,
        editTextBlank: isBlankPostText(safeEditText),
        editTextLen: isBlankPostText(safeEditText) ? 0 : safeEditText.length,
      })
      try {
        const editStartedAt = performance.now()
        await apiCallWithRetry(() =>
          bot.api.editMessage(post.message_mid, { text: safeEditText, attachments }),
        )
        const editMs = Math.round(performance.now() - editStartedAt)
        const timing = apiDuration()
        logger.info(`commentButton: кнопка добавлена через edit поста (${timing.apiDuration})`, {
          ...logBase,
          method: 'edit',
          editMs,
          ...timing,
        })
        return true
      } catch (err: unknown) {
        logger.warn('commentButton: editMessage не удался — пробуем reply с кнопкой', {
          ...logBase,
          attachmentCount: attachments.length,
          ...apiDuration(),
          err,
        })
        if (logCtx?.inlineOnly) {
          logger.info('commentButton: inline-only mode, skip reply fallback after edit failure', {
            ...logBase,
          })
          return false
        }
      }
    }
  }
  try {
    const replyStartedAt = performance.now()
    const replyStub = CHANNEL_POST_EMPTY_TEXT_PLACEHOLDER
    const sent = await apiCallWithRetry(() =>
      bot.api.sendMessageToChat(post.chat_id, replyStub, {
        attachments: [keyboard],
        link: { type: 'reply', mid: post.message_mid },
      }),
    )
    const replyMs = Math.round(performance.now() - replyStartedAt)
    const uiMid = sent.body.mid
    postStore.savePost({ ...post, comments_ui_message_mid: uiMid })
    const timing = apiDuration()
    logger.info(`commentButton: кнопка добавлена через reply под постом (${timing.apiDuration})`, {
      ...logBase,
      method: 'reply',
      commentsUiMessageMid: uiMid,
      replyMs,
      ...timing,
    })
    return true
  } catch (err: unknown) {
    logger.error(`commentButton: reply с кнопкой тоже не удался (${apiDuration().apiDuration})`, {
      ...logBase,
      ...apiDuration(),
      err,
    })
    return false
  }
}

function maxStartappPayload(
  postId: string,
  chatId: number,
  messageMid?: string,
  extra?: Record<string, string>,
): string {
  const compactId = postId.replace(/-/g, '')
  const suffix = extra?.admin === '1' ? '_admin' : ''
  const midPart =
    messageMid && messageMid.trim() !== ''
      ? `_mid_${encodeMessageMidForStartapp(messageMid.trim())}`
      : ''
  return `pid_${compactId}_cid_${Math.abs(chatId)}${midPart}${suffix}`
}

/** True if we can build a link that opens the Mini App (MAX deep link or legacy MINI_APP_URL). */
export function isMiniAppOpenUrlConfigured(): boolean {
  return config.botNickname.trim() !== '' || Boolean(config.miniAppUrl)
}

/**
 * MAX Mini App: `https://max.ru/<bot>?startapp=<payload>` (payload: A–Z, a–z, 0–9, _, -).
 * Fallback: legacy {@link config.miniAppUrl} with `post_id` / `chat_id` query params.
 */
/** Returns shareable channel post URL; fetches from MAX API and persists when missing in DB. */
export async function resolveChannelPostUrl(bot: Bot, post: Post): Promise<string | null> {
  const stored = post.channel_post_url?.trim()
  if (stored) {
    return stored
  }
  let message: Message | undefined
  try {
    message = await bot.api.getMessage(post.message_mid)
  } catch {
    try {
      const { messages } = await bot.api.getMessages(post.chat_id, {
        message_ids: [post.message_mid],
      })
      message = messages[0]
    } catch (err: unknown) {
      logger.warn('resolveChannelPostUrl: could not load message', {
        postId: post.post_id,
        messageMid: post.message_mid,
        err,
      })
      return null
    }
  }
  const url = message?.url?.trim()
  if (!url) {
    return null
  }
  postStore.savePost({ ...post, channel_post_url: url })
  return url
}

/** Comment button deep link — always includes `_mid_` in startapp (required for reliable Mini App lookup). */
export function buildCommentMiniAppUrl(postId: string, chatId: number, messageMid: string): string {
  const mid = messageMid.trim()
  if (mid === '') {
    throw new Error('buildCommentMiniAppUrl: message_mid is required')
  }
  return buildMiniAppUrl(postId, chatId, undefined, mid)
}

export function commentButtonStartappHasMid(postId: string, chatId: number, messageMid: string): boolean {
  try {
    const url = buildCommentMiniAppUrl(postId, chatId, messageMid)
    const startParam = new URL(url).searchParams.get('startapp') ?? ''
    return startParam.includes('_mid_')
  } catch {
    return false
  }
}

export function buildMiniAppUrl(
  postId: string,
  chatId: number,
  extra?: Record<string, string>,
  messageMid?: string,
): string {
  if ((!extra || extra.admin !== '1') && (!messageMid || messageMid.trim() === '')) {
    logger.warn('buildMiniAppUrl: message_mid missing for post link', {
      postId,
      chatId,
      extra,
    })
  }
  const payload = maxStartappPayload(postId, chatId, messageMid, extra)
  const nick = config.botNickname.trim()
  let buttonUrl: string
  if (nick) {
    buttonUrl = `https://max.ru/${nick}?startapp=${payload}`
  } else {
    const base = config.miniAppUrl
    if (!base) {
      throw new Error('buildMiniAppUrl: задайте BOT_NICKNAME или MINI_APP_URL')
    }
    const u = new URL(base.replace(/\/+$/, ''))
    u.searchParams.set('post_id', postId)
    u.searchParams.set('chat_id', String(chatId))
    if (messageMid && messageMid.trim() !== '') {
      u.searchParams.set('message_mid', messageMid.trim())
    }
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        u.searchParams.set(k, v)
      }
    }
    buttonUrl = u.toString()
  }
  return buttonUrl
}

/** Новые комментарии в MAX miniapp закрыты — обсуждение на другой платформе (пока действует TTL брони). */
export function isPostCommentsClosedInMax(post: Post): boolean {
  if (!isCommentsBookingActive(post)) {
    return false
  }
  return post.comments_booked_by === 'telegram' || post.comments_booked_by === 'vk'
}

/** Inline-клавиатура под постом: комментарии или «Забронировано в …» с той же ссылкой в miniapp. */
export function buildPostCommentKeyboard(post: Post): InlineKeyboardAttachmentRequest {
  const url = buildCommentMiniAppUrl(post.post_id, post.chat_id, post.message_mid)
  if (isPostCommentsClosedInMax(post) && post.comments_booked_by === 'telegram') {
    return Keyboard.inlineKeyboard([
      [Keyboard.button.link(formatMaxBookedInTgButtonLabel(post.comment_count), url)],
    ])
  }
  if (isPostCommentsClosedInMax(post) && post.comments_booked_by === 'vk') {
    return Keyboard.inlineKeyboard([
      [Keyboard.button.link(formatMaxBookedInVkButtonLabel(post.comment_count), url)],
    ])
  }
  const POST_ARCHIVE_DAYS = Number(process.env.COMMENT_TTL_DAYS ?? 21)
  const postAgeMs = Date.now() - new Date(post.timestamp).getTime()
  const isOld = postAgeMs > POST_ARCHIVE_DAYS * 24 * 60 * 60 * 1000
  const buttonText = isOld
    ? '📦 Архив комментариев'
    : `💬 Комментарии (${post.comment_count})`
  return Keyboard.inlineKeyboard([[Keyboard.button.link(buttonText, url)]])
}

export const postStore = new PostStore()
