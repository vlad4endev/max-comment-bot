import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Bot } from '@maxhub/max-bot-api'
import { Keyboard } from '@maxhub/max-bot-api'

import { config } from '../config'
import { logger } from '../utils/logger'

/**
 * Channel post tracked for Mini App comments (MAX message id is {@link Post.message_mid}).
 */
export interface Post {
  post_id: string
  chat_id: number
  message_mid: string
  text: string
  photo_url?: string
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
    typeof o.text === 'string' &&
    (o.photo_url === undefined || typeof o.photo_url === 'string') &&
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
   * Updates the channel message inline keyboard to show the current comment count.
   */
  async updateButtonCaption(bot: Bot, post: Post): Promise<void> {
    const base = config.miniAppUrl
    if (!base) {
      logger.warn('postStore.updateButtonCaption: MINI_APP_URL not set')
      return
    }
    const url = buildMiniAppUrl(base, post.post_id, post.chat_id)
    const kb = Keyboard.inlineKeyboard([
      [Keyboard.button.link(`💬 Комментарии (${post.comment_count})`, url)],
    ])
    const text = post.text.trim() === '' ? '\u00a0' : post.text
    try {
      await bot.api.editMessage(post.message_mid, {
        text,
        attachments: [kb],
      })
    } catch (err: unknown) {
      logger.warn('postStore.updateButtonCaption: editMessage failed', {
        postId: post.post_id,
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
 * Builds Mini App open URL with required query params (URL-encoded).
 */
export function buildMiniAppUrl(
  miniAppBase: string,
  postId: string,
  chatId: number,
  extra?: Record<string, string>,
): string {
  const u = new URL(miniAppBase.replace(/\/+$/, ''))
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
