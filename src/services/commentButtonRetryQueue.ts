import type { Bot } from '@maxhub/max-bot-api'
import pLimit from 'p-limit'

import { logger } from '../utils/logger'
import { resolveCanonicalChannelChatId } from './resolveChannelChatId'
import { ensurePostFromChannelMessage } from './channelPostActions'
import { postStore } from './postStore'

const MAX_ATTEMPTS = 10
const RETRY_TICK_MS = 2_500
const RETRY_CONCURRENCY = 4
const BASE_BACKOFF_MS = 3_000
const MAX_BACKOFF_MS = 120_000

interface RetryEntry {
  chatId: number
  messageMid: string
  attempts: number
  nextAt: number
}

const queue = new Map<string, RetryEntry>()
let intervalId: ReturnType<typeof setInterval> | undefined
let botRef: Bot | null = null
const limit = pLimit(RETRY_CONCURRENCY)

function queueKey(chatId: number, messageMid: string): string {
  const canonical = resolveCanonicalChannelChatId(chatId) ?? chatId
  return `${canonical}:${messageMid}`
}

/**
 * Планирует повторную привязку кнопки (после attach_failed или пропущенного webhook).
 */
export function scheduleCommentButtonRetry(chatId: number, messageMid: string): void {
  const mid = messageMid.trim()
  if (mid === '') {
    return
  }
  const canonical = resolveCanonicalChannelChatId(chatId) ?? chatId
  const existing = postStore.findPostByChannelMessage(canonical, mid)
  if (existing && existing.button_attach_pending !== true) {
    return
  }
  const key = queueKey(canonical, mid)
  const prev = queue.get(key)
  if (prev && prev.attempts >= MAX_ATTEMPTS) {
    return
  }
  const nextAt = Date.now() + (prev ? Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** prev.attempts) : 1_500)
  queue.set(key, {
    chatId: canonical,
    messageMid: mid,
    attempts: prev?.attempts ?? 0,
    nextAt,
  })
  logger.info('commentButtonRetry: scheduled', {
    chatId: canonical,
    messageMid: mid,
    attempts: prev?.attempts ?? 0,
    nextInMs: Math.max(0, nextAt - Date.now()),
    queueSize: queue.size,
  })
}

async function processOneRetry(bot: Bot, entry: RetryEntry, key: string): Promise<void> {
  const post = await ensurePostFromChannelMessage(bot, entry.chatId, entry.messageMid)
  if (post) {
    queue.delete(key)
    logger.info('commentButtonRetry: success', {
      chatId: entry.chatId,
      messageMid: entry.messageMid,
      postId: post.post_id,
      attempts: entry.attempts,
    })
    return
  }

  const attempts = entry.attempts + 1
  if (attempts >= MAX_ATTEMPTS) {
    queue.delete(key)
    logger.warn('commentButtonRetry: giving up', {
      chatId: entry.chatId,
      messageMid: entry.messageMid,
      attempts,
    })
    return
  }

  const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempts)
  queue.set(key, {
    ...entry,
    attempts,
    nextAt: Date.now() + backoff,
  })
  logger.info('commentButtonRetry: will retry', {
    chatId: entry.chatId,
    messageMid: entry.messageMid,
    attempts,
    backoffMs: backoff,
  })
}

async function drainRetryQueue(bot: Bot): Promise<void> {
  const now = Date.now()
  const ready = [...queue.entries()]
    .filter(([, e]) => e.nextAt <= now)
    .slice(0, 20)
  if (ready.length === 0) {
    return
  }
  await Promise.all(
    ready.map(([key, entry]) => limit(() => processOneRetry(bot, entry, key))),
  )
}

export function startCommentButtonRetryLoop(bot: Bot): void {
  stopCommentButtonRetryLoop()
  botRef = bot
  void drainRetryQueue(bot)
  intervalId = setInterval(() => {
    if (!botRef) {
      return
    }
    void drainRetryQueue(botRef).catch((err: unknown) => {
      logger.error('commentButtonRetry: tick error', err)
    })
  }, RETRY_TICK_MS)
  logger.info('commentButtonRetry: started', {
    tickMs: RETRY_TICK_MS,
    concurrency: RETRY_CONCURRENCY,
    maxAttempts: MAX_ATTEMPTS,
  })
}

export function stopCommentButtonRetryLoop(): void {
  if (intervalId !== undefined) {
    clearInterval(intervalId)
    intervalId = undefined
  }
  botRef = null
  logger.info('commentButtonRetry: stopped')
}

export function clearCommentButtonRetriesForChannel(chatId: number): void {
  const abs = Math.abs(resolveCanonicalChannelChatId(chatId) ?? chatId)
  for (const key of [...queue.keys()]) {
    const entry = queue.get(key)
    if (entry && Math.abs(entry.chatId) === abs) {
      queue.delete(key)
    }
  }
}

export function getCommentButtonRetryQueueSize(): number {
  return queue.size
}
