import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Bot } from '@maxhub/max-bot-api'
import { Keyboard } from '@maxhub/max-bot-api'
import type {
  Attachment,
  AttachmentRequest,
  InlineKeyboardAttachmentRequest,
  Message,
} from '@maxhub/max-bot-api/types'

import { config } from '../config'
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
  /**
   * Non-keyboard attachments from the channel post (from {@link Message.body.attachments}).
   * Used so {@link Bot.api.editMessage} can merge media with the inline keyboard instead of replacing all attachments.
   */
  media_attachments?: AttachmentRequest[]
  comment_count: number
  timestamp: string
}

interface PostsFileShape {
  posts: Post[]
}

const DEFAULT_POSTS_PATH = join(process.cwd(), 'data', 'posts.json')

function isPost(value: unknown): value is Post {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const o = value as Record<string, unknown>
  return (
    typeof o.post_id === 'string' &&
    typeof o.chat_id === 'number' &&
    Number.isInteger(o.chat_id) &&
    typeof o.message_mid === 'string' &&
    (o.comments_ui_message_mid === undefined || typeof o.comments_ui_message_mid === 'string') &&
    (o.sender_name === undefined || typeof o.sender_name === 'string') &&
    typeof o.text === 'string' &&
    (o.photo_url === undefined || typeof o.photo_url === 'string') &&
    (o.media_attachments === undefined ||
      (Array.isArray(o.media_attachments) &&
        o.media_attachments.every(
          (x) =>
            typeof x === 'object' &&
            x !== null &&
            'type' in x &&
            typeof (x as { type: unknown }).type === 'string',
        ))) &&
    typeof o.comment_count === 'number' &&
    Number.isInteger(o.comment_count) &&
    o.comment_count >= 0 &&
    typeof o.timestamp === 'string'
  )
}

/**
 * JSON-backed map of posts by `post_id`, with async persistence under `data/posts.json`.
 */
export class PostStore {
  private readonly byId = new Map<string, Post>()
  private readonly filePath: string
  private persistChain: Promise<void> = Promise.resolve()

  constructor(filePath: string = DEFAULT_POSTS_PATH) {
    this.filePath = filePath
  }

  /**
   * Loads posts from disk into memory (replaces cache).
   */
  async loadFromDisk(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw) as unknown
      if (typeof parsed !== 'object' || parsed === null || !('posts' in parsed)) {
        logger.warn('postStore: invalid posts.json shape, starting empty')
        this.byId.clear()
        return
      }
      const list = (parsed as PostsFileShape).posts
      if (!Array.isArray(list)) {
        this.byId.clear()
        return
      }
      this.byId.clear()
      for (const item of list) {
        if (isPost(item)) {
          this.byId.set(item.post_id, item)
        }
      }
      logger.info(`postStore: loaded ${this.byId.size} post(s)`)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        logger.debug('postStore: posts.json missing, empty store')
        return
      }
      logger.error('postStore: failed to read posts.json', e)
    }
  }

  /**
   * Persists or replaces a post in memory and queues disk write.
   */
  savePost(post: Post): void {
    this.byId.set(post.post_id, post)
    this.queuePersist()
  }

  /**
   * Returns a post by id or `null`.
   */
  getPost(postId: string): Post | null {
    return this.byId.get(postId) ?? null
  }

  /**
   * All posts in a channel (for /status counts).
   */
  getPostsByChatId(chatId: number): Post[] {
    return [...this.byId.values()].filter((p) => p.chat_id === chatId)
  }

  /**
   * Whether we already track this channel message (same {@link Post.message_mid}).
   */
  findPostByChannelMessage(chatId: number, messageMid: string): Post | null {
    for (const p of this.byId.values()) {
      if (p.chat_id === chatId && p.message_mid === messageMid) {
        return p
      }
    }
    return null
  }

  /**
   * Increments {@link Post.comment_count} and persists. Returns new count or `null` if unknown post.
   */
  incrementCommentCount(postId: string): number | null {
    const p = this.byId.get(postId)
    if (!p) {
      return null
    }
    const next: Post = { ...p, comment_count: p.comment_count + 1 }
    this.byId.set(postId, next)
    this.queuePersist()
    return next.comment_count
  }

  /**
   * Decrements {@link Post.comment_count} (floored at 0). Returns new count or `null` if unknown post.
   */
  decrementCommentCount(postId: string): number | null {
    const p = this.byId.get(postId)
    if (!p) {
      return null
    }
    const next: Post = { ...p, comment_count: Math.max(0, p.comment_count - 1) }
    this.byId.set(postId, next)
    this.queuePersist()
    return next.comment_count
  }

  /**
   * Updates the channel message inline keyboard to show the current comment count.
   */
  async updateButtonCaption(bot: Bot, post: Post): Promise<void> {
    if (!isMiniAppOpenUrlConfigured()) {
      logger.warn('postStore.updateButtonCaption: BOT_NICKNAME / MINI_APP_URL not usable for links')
      return
    }
    const url = buildMiniAppUrl(post.post_id, post.chat_id)
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

  private queuePersist(): void {
    this.persistChain = this.persistChain
      .then(() => this.persist())
      .catch((e: unknown) => {
        logger.error('postStore: persist error', e)
      })
  }

  private async persist(): Promise<void> {
    const dir = dirname(this.filePath)
    await mkdir(dir, { recursive: true })
    const body: PostsFileShape = {
      posts: [...this.byId.values()].sort((a, b) => a.post_id.localeCompare(b.post_id)),
    }
    await writeFile(this.filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
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

function maxStartappPayload(postId: string, chatId: number, extra?: Record<string, string>): string {
  const compactId = postId.replace(/-/g, '')
  const suffix = extra?.admin === '1' ? '_admin' : ''
  return `pid_${compactId}_cid_${Math.abs(chatId)}${suffix}`
}

/** True if we can build a link that opens the Mini App (MAX deep link or legacy MINI_APP_URL). */
export function isMiniAppOpenUrlConfigured(): boolean {
  return config.botNickname.trim() !== '' || Boolean(config.miniAppUrl)
}

/**
 * MAX Mini App: `https://max.ru/<bot>?startapp=<payload>` (payload: A–Z, a–z, 0–9, _, -).
 * Fallback: legacy {@link config.miniAppUrl} with `post_id` / `chat_id` query params.
 */
export function buildMiniAppUrl(postId: string, chatId: number, extra?: Record<string, string>): string {
  const payload = maxStartappPayload(postId, chatId, extra)
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
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      u.searchParams.set(k, v)
    }
  }
  return u.toString()
}

export const postStore = new PostStore()
