import type { Bot } from '@maxhub/max-bot-api'
import type { Message } from '@maxhub/max-bot-api/types'

import { ensurePostFromChannelMessage } from './channelPostActions'
import { fetchChannelMessagesSince } from './channelPoller'
import { resolveCanonicalChannelChatId } from './resolveChannelChatId'
import { logger } from '../utils/logger'
import { parseStartappPayload } from '../utils/startappPayload'
import { postStore, type Post } from './postStore'

const RECOVERY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
const RECOVERY_MAX_PAGES = 12

function postIdsMatch(requested: string, fromPayload: string): boolean {
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

function extractStartappFromMessage(message: Message): string | null {
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

function messageMidMatchesPostId(message: Message, postId: string): boolean {
  const mid = message.body?.mid?.trim()
  if (!mid) {
    return false
  }
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
 * Orphan Mini App link: `post_id` on the button, no row in SQLite — scan recent channel feed for matching keyboard.
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
    const messageMid = message.body?.mid?.trim()
    if (!messageMid) {
      continue
    }
    const row = postStore.findPostByChannelMessage(canonical, messageMid)
    if (row) {
      logger.info('miniappPostRecovery: post row already exists for scanned message_mid', {
        requestedPostId: id,
        postId: row.post_id,
        chatId: canonical,
        messageMid,
      })
      return row
    }
    const restored = await ensurePostFromChannelMessage(bot, canonical, messageMid)
    if (restored) {
      logger.info('miniappPostRecovery: restored post from channel feed scan', {
        requestedPostId: id,
        postId: restored.post_id,
        chatId: canonical,
        messageMid,
      })
      return restored
    }
  }

  logger.warn('miniappPostRecovery: no channel message with matching button post_id', {
    chatId: canonical,
    postId: id,
    messagesScanned: messages.length,
  })
  return null
}
