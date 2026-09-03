import type { Bot } from '@maxhub/max-bot-api'
import type { Message } from '@maxhub/max-bot-api/types'

import { ensurePostFromChannelMessage } from './channelPostActions'
import { fetchChannelMessagesSince } from './channelPoller'
import { findPostByAlias, rememberPostIdAlias } from './postIdAliasStore'
import { resolveCanonicalChannelChatId } from './resolveChannelChatId'
import { logger } from '../utils/logger'
import { parseStartappPayload } from '../utils/startappPayload'
import { postStore, type Post } from './postStore'

/** Mini App lookup inputs after parsing query + startapp header. */
export interface MiniappPostLookup {
  postId: string
  chatIdRaw: number | null
  messageMid: string | null
}

/** Only when a new post row may still be committing (has message_mid in link). */
const RACE_RETRY_MS = 400
const FEED_SCAN_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
const FEED_SCAN_MAX_PAGES = 20

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function postIdsMatch(requested: string, fromPayload: string): boolean {
  const a = requested.trim().toLowerCase()
  const b = fromPayload.trim().toLowerCase()
  if (a === b) {
    return true
  }
  return a.replace(/-/g, '') === b.replace(/-/g, '')
}

function collectUrlStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (value.includes('startapp=') || value.includes('pid_')) {
      out.push(value)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectUrlStrings(item, out)
    }
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) {
      collectUrlStrings(v, out)
    }
  }
}

export function extractStartappFromMessage(message: Message): string | null {
  const urls: string[] = []
  for (const att of message.body.attachments ?? []) {
    collectUrlStrings(att, urls)
  }
  for (const raw of urls) {
    try {
      const sp = new URL(raw).searchParams.get('startapp')
      if (sp?.trim()) {
        return sp.trim()
      }
    } catch {
      const m = /startapp=([^&]+)/i.exec(raw)
      if (m?.[1]) {
        return decodeURIComponent(m[1])
      }
    }
    const direct = raw.trim()
    if (/^pid_/i.test(direct)) {
      return direct
    }
  }
  return null
}

/** Channel post `message_mid` (for reply UI stubs — the linked parent post). */
export function resolveChannelMessageMid(message: Message): string | null {
  const bodyMid = message.body?.mid?.trim()
  if (!bodyMid) {
    return null
  }
  const link = message.link as { type?: string; mid?: string } | undefined
  if (link?.type === 'reply' && typeof link.mid === 'string' && link.mid.trim() !== '') {
    return link.mid.trim()
  }
  return bodyMid
}

function messageMidMatchesPostId(message: Message, postId: string): boolean {
  const startapp = extractStartappFromMessage(message)
  if (!startapp) {
    return false
  }
  const parsed = parseStartappPayload(startapp)
  if (!parsed?.post_id) {
    return false
  }
  return postIdsMatch(postId, parsed.post_id)
}

function rememberAliasIfNeeded(requestedPostId: string, post: Post): Post {
  if (requestedPostId.trim() !== '' && !postIdsMatch(requestedPostId, post.post_id)) {
    rememberPostIdAlias(requestedPostId, post)
  }
  return post
}

/**
 * Orphan Mini App link: `post_id` on the button, no row in SQLite — scan channel feed (slow, once).
 */
export async function recoverPostByPostIdInChannelFeed(
  bot: Bot,
  chatId: number,
  postId: string,
): Promise<Post | null> {
  const id = postId.trim()
  if (!id) {
    return null
  }

  const fromAlias = findPostByAlias(id)
  if (fromAlias) {
    return fromAlias
  }

  const canonical = resolveCanonicalChannelChatId(chatId) ?? chatId
  const existing = postStore.getPost(id)
  if (existing) {
    return existing
  }

  const cutoffMs = Date.now() - FEED_SCAN_LOOKBACK_MS
  let messages: Message[] = []
  try {
    messages = await fetchChannelMessagesSince(bot, canonical, cutoffMs, {
      maxPages: FEED_SCAN_MAX_PAGES,
    })
  } catch (err: unknown) {
    logger.warn('miniappPostRecovery: getMessages failed', { chatId: canonical, postId: id, err })
    return null
  }

  if (messages.length === 0) {
    try {
      const { messages: latest } = await bot.api.getMessages(canonical, { count: 100 })
      messages = latest
      logger.warn('miniappPostRecovery: windowed feed empty, fallback to latest 100', {
        chatId: canonical,
        postId: id,
        latestCount: latest.length,
      })
    } catch (err: unknown) {
      logger.warn('miniappPostRecovery: latest-100 fallback failed', {
        chatId: canonical,
        postId: id,
        err,
      })
    }
  }

  for (const message of messages) {
    if (!messageMidMatchesPostId(message, id)) {
      continue
    }
    const channelMid = resolveChannelMessageMid(message)
    if (!channelMid) {
      continue
    }
    const row = postStore.findPostByChannelMessage(canonical, channelMid)
    if (row) {
      logger.info('miniappPostRecovery: matched button on channel feed (row exists)', {
        requestedPostId: id,
        postId: row.post_id,
        chatId: canonical,
        messageMid: channelMid,
      })
      return rememberAliasIfNeeded(id, row)
    }
    const restored = await ensurePostFromChannelMessage(bot, canonical, channelMid, {
      preferredPostId: id,
      reattachButton: true,
    })
    if (restored) {
      logger.info('miniappPostRecovery: restored post from channel feed scan', {
        requestedPostId: id,
        postId: restored.post_id,
        chatId: canonical,
        messageMid: channelMid,
      })
      return rememberAliasIfNeeded(id, restored)
    }
  }

  logger.warn('miniappPostRecovery: no channel message with matching button post_id', {
    chatId: canonical,
    postId: id,
    messagesScanned: messages.length,
    lookbackDays: Math.round(FEED_SCAN_LOOKBACK_MS / (24 * 60 * 60 * 1000)),
  })
  return null
}

export interface ResolveMiniappPostOpenOptions {
  /** Heavy MAX feed scan (up to 7 days). Only for explicit refresh, never on first open. */
  allowFeedScan?: boolean
}

/**
 * Resolves a post for Mini App open: alias/DB (fast) → short race retry → ensure by mid.
 * Feed scan is opt-in — it blocks HTTP and the miniapp spinner for many seconds.
 */
export async function resolveMiniappPostOpen(
  bot: Bot,
  lookup: MiniappPostLookup,
  resolveFromDb: (postId: string, chatIdRaw: number | null, messageMid: string | null) => Post | null,
  options: ResolveMiniappPostOpenOptions = {},
): Promise<Post | null> {
  const postId = lookup.postId.trim()
  const mid = lookup.messageMid?.trim() ?? ''

  if (postId !== '') {
    const fromAlias = findPostByAlias(postId)
    if (fromAlias) {
      return fromAlias
    }
  }

  let post = resolveFromDb(lookup.postId, lookup.chatIdRaw, lookup.messageMid)
  if (post) {
    return rememberAliasIfNeeded(postId, post)
  }

  /** Brief retry only when `message_mid` is present — new publish race, not orphan UUID. */
  if (mid !== '') {
    await sleepMs(RACE_RETRY_MS)
    post = resolveFromDb(lookup.postId, lookup.chatIdRaw, lookup.messageMid)
    if (post) {
      return rememberAliasIfNeeded(postId, post)
    }
  }

  if (mid !== '') {
    const canonicalChatId =
      lookup.chatIdRaw !== null
        ? (resolveCanonicalChannelChatId(lookup.chatIdRaw) ?? lookup.chatIdRaw)
        : null
    if (canonicalChatId !== null) {
      post = await ensurePostFromChannelMessage(bot, canonicalChatId, mid, {
        preferredPostId: postId || undefined,
        reattachButton: false,
      })
    } else {
      post = postStore.findByMessageMid(mid)
    }
    if (post) {
      return rememberAliasIfNeeded(postId, post)
    }
  }

  if (options.allowFeedScan && postId !== '' && lookup.chatIdRaw !== null) {
    post = await recoverPostByPostIdInChannelFeed(bot, lookup.chatIdRaw, postId)
  }

  return post
}
