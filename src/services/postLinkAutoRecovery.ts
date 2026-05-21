import type { Bot } from '@maxhub/max-bot-api'

import { isCommentsButtonEnabledForMaxChannel } from './channelCommentsButtonPolicy'
import { ensurePostFromChannelMessage } from './channelPostActions'
import { resolveCanonicalChannelChatId } from './resolveChannelChatId'
import { postStore } from './postStore'
import { logger, subscribeLoggerEvents } from '../utils/logger'

interface RecoveryTask {
  chatId: number
  messageMid: string
  reason: 'miniapp_post_lookup_not_found' | 'post_id_mismatch'
}

const RECOVERY_DEDUP_MS = 2 * 60 * 1000
const recentRecoveries = new Map<string, number>()
let unsubscribeLogger: (() => void) | null = null
let queue = Promise.resolve()
let botRef: Bot | null = null
type RecoveryStatsMutable = {
  total_recovered: number
  total_failed: number
  today_recovered: number
  today_failed: number
  today_key: string
}
const recoveryStats: RecoveryStatsMutable = {
  total_recovered: 0,
  total_failed: 0,
  today_recovered: 0,
  today_failed: 0,
  today_key: new Date().toISOString().slice(0, 10),
}

function rotateDailyStatsIfNeeded(): void {
  const key = new Date().toISOString().slice(0, 10)
  if (recoveryStats.today_key === key) {
    return
  }
  recoveryStats.today_key = key
  recoveryStats.today_recovered = 0
  recoveryStats.today_failed = 0
}

function markRecovered(): void {
  rotateDailyStatsIfNeeded()
  recoveryStats.total_recovered += 1
  recoveryStats.today_recovered += 1
}

function markFailed(): void {
  rotateDailyStatsIfNeeded()
  recoveryStats.total_failed += 1
  recoveryStats.today_failed += 1
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return null
  }
  return v as Record<string, unknown>
}

function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) {
    return v
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number.parseInt(v, 10)
    if (Number.isInteger(n)) {
      return n
    }
  }
  return null
}

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') {
    return null
  }
  const t = v.trim()
  return t === '' ? null : t
}

function dedupKey(chatId: number, messageMid: string): string {
  return `${Math.abs(chatId)}|${messageMid}`
}

function shouldRunRecovery(chatId: number, messageMid: string): boolean {
  const key = dedupKey(chatId, messageMid)
  const now = Date.now()
  const prev = recentRecoveries.get(key) ?? 0
  if (now - prev < RECOVERY_DEDUP_MS) {
    return false
  }
  recentRecoveries.set(key, now)
  if (recentRecoveries.size > 2000) {
    for (const [k, at] of recentRecoveries) {
      if (now - at > RECOVERY_DEDUP_MS * 3) {
        recentRecoveries.delete(k)
      }
    }
  }
  return true
}

async function runRecoveryTask(task: RecoveryTask): Promise<void> {
  const bot = botRef
  if (!bot) {
    return
  }
  const canonicalChatId = resolveCanonicalChannelChatId(task.chatId) ?? task.chatId
  if (!isCommentsButtonEnabledForMaxChannel(canonicalChatId)) {
    logger.info('postLinkAutoRecovery: пропуск — кнопка отключена в связке TG→MAX', {
      chatId: canonicalChatId,
      messageMid: task.messageMid,
      reason: task.reason,
    })
    return
  }
  const restored = await ensurePostFromChannelMessage(bot, canonicalChatId, task.messageMid)
  if (restored) {
    markRecovered()
    logger.info('postLinkAutoRecovery: восстановлено по лог-сигналу', {
      reason: task.reason,
      chatId: canonicalChatId,
      messageMid: task.messageMid,
      postId: restored.post_id,
    })
    return
  }
  markFailed()
  logger.warn('postLinkAutoRecovery: не удалось восстановить пост по лог-сигналу', {
    reason: task.reason,
    chatId: canonicalChatId,
    messageMid: task.messageMid,
  })
}

function enqueueRecovery(task: RecoveryTask): void {
  if (!shouldRunRecovery(task.chatId, task.messageMid)) {
    return
  }
  queue = queue
    .then(async () => {
      await runRecoveryTask(task)
    })
    .catch((err: unknown) => {
      logger.warn('postLinkAutoRecovery: task failed', { err })
    })
}

function extractTaskFromLogEvent(event: { message: string; extra?: unknown }): RecoveryTask | null {
  const extra = asRecord(event.extra)
  if (!extra) {
    return null
  }
  if (event.message === 'miniapp: post lookup' && extra.found === false) {
    const chatId = asInt(extra.chatId)
    const messageMid = asNonEmptyString(extra.messageMid)
    if (chatId === null || !messageMid) {
      return null
    }
    return {
      chatId,
      messageMid,
      reason: 'miniapp_post_lookup_not_found',
    }
  }
  if (event.message.includes('post_id в ссылке не совпадает')) {
    const chatId = asInt(extra.chatId)
    const messageMid = asNonEmptyString(extra.messageMid)
    if (chatId !== null && messageMid) {
      return {
        chatId,
        messageMid,
        reason: 'post_id_mismatch',
      }
    }
    const requestedPostId = asNonEmptyString(extra.requestedPostId)
    if (!requestedPostId) {
      return null
    }
    const post = postStore.getPost(requestedPostId)
    if (!post?.message_mid) {
      return null
    }
    return {
      chatId: post.chat_id,
      messageMid: post.message_mid,
      reason: 'post_id_mismatch',
    }
  }
  return null
}

export function startPostLinkAutoRecovery(bot: Bot): void {
  botRef = bot
  if (unsubscribeLogger) {
    return
  }
  unsubscribeLogger = subscribeLoggerEvents((event) => {
    const task = extractTaskFromLogEvent(event)
    if (!task) {
      return
    }
    enqueueRecovery(task)
  })
  logger.info('postLinkAutoRecovery: started')
}

export function stopPostLinkAutoRecovery(): void {
  if (unsubscribeLogger) {
    unsubscribeLogger()
    unsubscribeLogger = null
  }
  botRef = null
  logger.info('postLinkAutoRecovery: stopped')
}

export function getPostLinkAutoRecoveryStats(): {
  total_recovered: number
  total_failed: number
  today_recovered: number
  today_failed: number
  today_key: string
} {
  rotateDailyStatsIfNeeded()
  return {
    total_recovered: recoveryStats.total_recovered,
    total_failed: recoveryStats.total_failed,
    today_recovered: recoveryStats.today_recovered,
    today_failed: recoveryStats.today_failed,
    today_key: recoveryStats.today_key,
  }
}

