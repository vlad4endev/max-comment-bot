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
import { encodeMessageMidForStartapp } from '../utils/startappPayload'
import { logger } from '../utils/logger'

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
}

export class PostStore {
  private statements: {
    getPost: Database.Statement
    listByChatId: Database.Statement
    findByChatAndMid: Database.Statement
    findByAbsChatAndMid: Database.Statement
    upsert: Database.Statement
    deleteByChatId: Database.Statement
    selectIdsByChatId: Database.Statement
    deleteAll: Database.Statement
    countAll: Database.Statement
  } | null = null

  async loadFromDisk(): Promise<void> {
    logger.debug('postStore: SQLite backend active, loadFromDisk noop')
  }

  savePost(post: Post): void {
    this.getStatements().upsert.run(
      post.post_id,
      post.chat_id,
      post.message_mid,
      post.comments_ui_message_mid ?? null,
      post.sender_name ?? null,
      post.text,
      post.photo_url ?? null,
      post.media_attachments ? JSON.stringify(post.media_attachments) : null,
      post.comment_count,
      post.timestamp,
      JSON.stringify(post),
    )
  }

  getPost(postId: string): Post | null {
    const row = this.getStatements().getPost.get(postId) as { data: string } | undefined
    return row ? this.parsePost(row.data) : null
  }

  getPostsByChatId(chatId: number): Post[] {
    const rows = this.getStatements().listByChatId.all(chatId) as { data: string }[]
    return rows.map((row) => this.parsePost(row.data))
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

  incrementCommentCount(postId: string): number | null {
    const post = this.getPost(postId)
    if (!post) {
      return null
    }
    const next: Post = { ...post, comment_count: post.comment_count + 1 }
    this.savePost(next)
    return next.comment_count
  }

  decrementCommentCount(postId: string): number | null {
    const post = this.getPost(postId)
    if (!post) {
      return null
    }
    const next: Post = { ...post, comment_count: Math.max(0, post.comment_count - 1) }
    this.savePost(next)
    return next.comment_count
  }

  removePostsForChatId(chatId: number): string[] {
    const rows = this.getStatements().selectIdsByChatId.all(chatId) as { post_id: string }[]
    if (rows.length === 0) {
      return []
    }
    this.getStatements().deleteByChatId.run(chatId)
    return rows.map((row) => row.post_id)
  }

  clearAllPosts(): void {
    this.getStatements().deleteAll.run()
    logger.warn('postStore: clearAllPosts')
  }

  getTotalPostCount(): number {
    const row = this.getStatements().countAll.get() as { n: number }
    return Number(row.n) || 0
  }

  /**
   * Updates the channel message inline keyboard to show the current comment count.
   */
  async updateButtonCaption(bot: Bot, post: Post): Promise<void> {
    if (!isMiniAppOpenUrlConfigured()) {
      logger.warn('postStore.updateButtonCaption: BOT_NICKNAME / MINI_APP_URL not usable for links')
      return
    }
    const url = buildMiniAppUrl(post.post_id, post.chat_id, undefined, post.message_mid)
    const kb = Keyboard.inlineKeyboard([
      [Keyboard.button.link(`💬 Комментарии (${post.comment_count})`, url)],
    ])
    const targetMid = post.comments_ui_message_mid ?? post.message_mid
    const text =
      post.comments_ui_message_mid !== undefined
        ? '\u00a0'
        : post.text.trim() === ''
          ? '\u00a0'
          : post.text
    const usesReplyUi = post.comments_ui_message_mid !== undefined
    const { media } = usesReplyUi ? { media: [] as AttachmentRequest[] } : await resolveChannelPostMediaForEdit(bot, post)
    const attachments: AttachmentRequest[] =
      usesReplyUi || media.length === 0 ? [kb] : [...media, kb]
    try {
      await bot.api.editMessage(targetMid, {
        text,
        attachments,
      })
    } catch (err: unknown) {
      logger.warn('postStore.updateButtonCaption: editMessage failed', {
        postId: post.post_id,
        targetMid,
        err,
      })
    }
  }

  private parsePost(raw: string): Post {
    return JSON.parse(raw) as Post
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
      upsert: db.prepare(
        `INSERT OR REPLACE INTO posts (
          post_id, chat_id, message_mid, comments_ui_message_mid, sender_name, text,
          photo_url, media_attachments, comment_count, timestamp, data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      selectIdsByChatId: db.prepare('SELECT post_id FROM posts WHERE chat_id = ?'),
      deleteByChatId: db.prepare('DELETE FROM posts WHERE chat_id = ?'),
      deleteAll: db.prepare('DELETE FROM posts'),
      countAll: db.prepare('SELECT COUNT(*) AS n FROM posts'),
    }
    return this.statements
  }
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

/**
 * Resolves media to send with `editMessage` on the original channel post: prefers {@link Post.media_attachments},
 * otherwise loads the message via {@link Bot.api.getMessage} or {@link Bot.api.getMessages}.
 *
 * @returns `warnMissingSnapshot` true when the post had no cached media and the API did not yield a usable attachment list (fetch failure or empty `body.attachments`).
 */
async function resolveChannelPostMediaForEdit(
  bot: Bot,
  post: Post,
): Promise<{ media: AttachmentRequest[]; warnMissingSnapshot: boolean }> {
  if (post.media_attachments !== undefined) {
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
  if (!raw || raw.length === 0) {
    return { media: [], warnMissingSnapshot: true }
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
): Promise<void> {
  const { media, warnMissingSnapshot } = await resolveChannelPostMediaForEdit(bot, post)
  const attachments: AttachmentRequest[] =
    media.length > 0 ? [...media, keyboard] : [keyboard]
  if (warnMissingSnapshot) {
    logger.warn(
      'attachCommentButton: could not load original message attachments; editing with keyboard only (media may be dropped if present)',
      { postId: post.post_id, messageMid: post.message_mid, chatId: post.chat_id },
    )
  }
  try {
    await bot.api.editMessage(post.message_mid, {
      text: editText,
      attachments,
    })
    logger.info('attachCommentButton: edited original channel post', {
      postId: post.post_id,
      messageMid: post.message_mid,
    })
    return
  } catch (err: unknown) {
    logger.warn('attachCommentButton: editMessage failed, trying reply fallback', {
      postId: post.post_id,
      chatId: post.chat_id,
      messageMid: post.message_mid,
      err,
    })
  }
  try {
    const replyStub = '\u00a0'
    const sent = await bot.api.sendMessageToChat(post.chat_id, replyStub, {
      attachments: [keyboard],
      link: { type: 'reply', mid: post.message_mid },
    })
    const uiMid = sent.body.mid
    postStore.savePost({ ...post, comments_ui_message_mid: uiMid })
    logger.info('attachCommentButton: sent reply message with keyboard', {
      postId: post.post_id,
      commentsUiMessageMid: uiMid,
      replyToMid: post.message_mid,
    })
  } catch (err: unknown) {
    logger.error('attachCommentButton: reply fallback failed', {
      postId: post.post_id,
      chatId: post.chat_id,
      err,
    })
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

export function buildMiniAppUrl(
  postId: string,
  chatId: number,
  extra?: Record<string, string>,
  messageMid?: string,
): string {
  const payload = maxStartappPayload(postId, chatId, messageMid, extra)
  const nick = config.botNickname.trim()
  if (nick) {
    return `https://max.ru/${nick}?startapp=${payload}`
  }
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
  return u.toString()
}

export const postStore = new PostStore()
