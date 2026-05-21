import type { Bot } from '@maxhub/max-bot-api'
import type { Message } from '@maxhub/max-bot-api/types'

import { ensurePostFromChannelMessage } from './channelPostActions'
import { fetchChannelMessagesSince } from './channelPoller'
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

const RECOVERY_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000
const RECOVERY_MAX_PAGES = 25
const MINIAPP_LOOKUP_RETRY_MS = 2000

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

/**
 * Orphan Mini App link: `post_id` on the button, no row in SQLite — scan channel feed, register row, fix button.
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
  const canonical = resolveCanonicalChannelChatId(chatId) ?? chatId
  const existing = postStore.getPost(id)
  if (existing) {
    return existing
  }

  const cutoffMs = Date.now() - RECOVERY_LOOKBACK_MS
  let messages: Message[] = []
  try {
    messages = await fetchChannelMessagesSince(bot, canonical, cutoffMs, {
      maxPages: RECOVERY_MAX_PAGES,
    })
  } catch (err: unknown) {
    logger.warn('miniappPostRecovery: getMessages failed', { chatId: canonical, postId: id, err })
    return null
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
      if (!postIdsMatch(id, row.post_id)) {
        const fixed = await ensurePostFromChannelMessage(bot, canonical, channelMid, {
          reattachButton: true,
        })
        return fixed ?? row
      }
      return row
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
      return restored
    }
  }

  logger.warn('miniappPostRecovery: no channel message with matching button post_id', {
    chatId: canonical,
    postId: id,
    messagesScanned: messages.length,
    lookbackDays: Math.round(RECOVERY_LOOKBACK_MS / (24 * 60 * 60 * 1000)),
  })
  return null
}

/**
 * Resolves a post for Mini App open: DB → retry → ensure by mid → scan channel feed by orphan `post_id`.
 */
export async function resolveMiniappPostOpen(
  bot: Bot,
  lookup: MiniappPostLookup,
  resolveFromDb: (postId: string, chatIdRaw: number | null, messageMid: string | null) => Post | null,
): Promise<Post | null> {
  let post = resolveFromDb(lookup.postId, lookup.chatIdRaw, lookup.messageMid)
  if (post) {
    return post
  }
  await sleepMs(MINIAPP_LOOKUP_RETRY_MS)
  post = resolveFromDb(lookup.postId, lookup.chatIdRaw, lookup.messageMid)
  if (post) {
    logger.info('resolveMiniappPostOpen: post found after retry', {
      postId: lookup.postId,
      chatId: lookup.chatIdRaw,
      messageMid: lookup.messageMid,
    })
    return post
  }

  const mid = lookup.messageMid?.trim() ?? ''
  const postId = lookup.postId.trim()

  if (mid !== '') {
    const canonicalChatId =
      lookup.chatIdRaw !== null
        ? (resolveCanonicalChannelChatId(lookup.chatIdRaw) ?? lookup.chatIdRaw)
        : null
    if (canonicalChatId !== null) {
      post = await ensurePostFromChannelMessage(bot, canonicalChatId, mid, {
        preferredPostId: postId || undefined,
        reattachButton: true,
      })
    } else {
      post = postStore.findByMessageMid(mid)
    }
    if (post) {
      if (postId && post.post_id !== postId) {
        logger.info('resolveMiniappPostOpen: resolved by message_mid (post_id differs from link)', {
          requestedPostId: postId,
          postId: post.post_id,
          messageMid: mid,
        })
      }
      return post
    }
  }

  if (postId !== '' && lookup.chatIdRaw !== null) {
    post = await recoverPostByPostIdInChannelFeed(bot, lookup.chatIdRaw, postId)
  }

  return post
}
