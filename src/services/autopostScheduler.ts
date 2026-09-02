import { getTelegramToken } from '../config'
import { logger } from '../utils/logger'
import { integrationsStore } from './integrationsStore'
import { POSTS_DB_PATH } from '../db/postsDatabase'
import { evaluateAutopostGate, nextSlotForPost } from './autopostGates'
import {
  completeAutopost,
  listAutoposts,
  listDueAutoposts,
  markAutopostFailed,
  markAutopostSent,
  rescheduleAutopost,
  type AutopostRecord,
} from './autopostStore'
import { resolveMaxToken, sendAutopostToMax } from './autopostMaxSender'
import { sendAutopostToTelegram } from './autopostTelegramSender'

const DEFAULT_TICK_MS = 15_000

let intervalHandle: ReturnType<typeof setInterval> | null = null
let ticking = false
let tickMs = DEFAULT_TICK_MS
let startedAt: string | null = null
let lastTickAt: string | null = null
let lastDueCount = 0
let lastError: string | null = null

function getTickMs(): number {
  const raw = (process.env.AUTOPOST_TICK_MS ?? '').trim()
  if (raw === '') {
    return DEFAULT_TICK_MS
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 10_000) {
    return DEFAULT_TICK_MS
  }
  return Math.min(parsed, 300_000)
}

function resolveTelegramToken(): string | null {
  const fromEnv = getTelegramToken()
  if (fromEnv) {
    return fromEnv
  }
  const integ = integrationsStore.getTelegramIntegration()
  const token = integ?.token?.trim()
  return token || null
}

function finishRecurring(post: AutopostRecord, from: Date): void {
  const nextAt = nextSlotForPost(post, from)
  if (!nextAt) {
    completeAutopost(post.id, 'Серия завершена: нет следующего слота')
    logger.info('autopostScheduler: series completed', { id: post.id })
    return
  }
  markAutopostSent(post.id, { nextScheduledAt: nextAt, status: 'active' })
  logger.info('autopostScheduler: recurring post sent, next scheduled', {
    id: post.id,
    nextAt,
  })
}

async function afterSuccessfulSend(post: AutopostRecord): Promise<void> {
  if (post.schedule_type === 'once') {
    markAutopostSent(post.id, { status: 'sent' })
    logger.info('autopostScheduler: one-time post sent', { id: post.id, channel: post.target_channel_id })
    return
  }
  finishRecurring(post, new Date())
}

function handleSendFailure(post: AutopostRecord, message: string): void {
  const policy = post.on_failure
  if (policy === 'skip' && post.schedule_type === 'recurring') {
    const nextAt = nextSlotForPost(post, new Date())
    if (nextAt) {
      markAutopostFailed(post.id, message, { keepActive: true, nextScheduledAt: nextAt })
      logger.warn('autopostScheduler: skipped occurrence, next scheduled', { id: post.id, nextAt, error: message })
      return
    }
  }
  markAutopostFailed(post.id, message)
}

async function processDuePost(post: AutopostRecord): Promise<void> {
  const gate = evaluateAutopostGate(post)
  if (!gate.ok) {
    const terminal =
      gate.reason?.includes('лимит повторов') || gate.reason?.includes('закончилась')
    if (terminal) {
      completeAutopost(post.id, gate.reason || 'Серия завершена')
      logger.info('autopostScheduler: series stopped by gate', { id: post.id, reason: gate.reason })
      return
    }
    if (gate.retryAt) {
      rescheduleAutopost(post.id, gate.retryAt, gate.reason)
      logger.info('autopostScheduler: deferred by condition', {
        id: post.id,
        reason: gate.reason,
        retryAt: gate.retryAt,
      })
      return
    }
    handleSendFailure(post, gate.reason || 'Условие публикации не выполнено')
    return
  }

  try {
    if (post.platform === 'max') {
      const maxToken = resolveMaxToken()
      if (!maxToken) {
        handleSendFailure(post, 'MAX bot token not configured')
        return
      }
      await sendAutopostToMax(maxToken, post)
      await afterSuccessfulSend(post)
      return
    }

    const tgToken = resolveTelegramToken()
    if (!tgToken) {
      handleSendFailure(post, 'Telegram bot token not configured')
      return
    }
    const result = await sendAutopostToTelegram(tgToken, post)
    if (result.warning) {
      logger.info('autopostScheduler: sent with notice', { id: post.id, warning: result.warning })
    }
    await afterSuccessfulSend(post)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    handleSendFailure(post, message)
    logger.error('autopostScheduler: send failed', { id: post.id, platform: post.platform, error: message })
  }
}

async function tick(): Promise<void> {
  if (ticking) {
    return
  }
  ticking = true
  try {
    const nowIso = new Date().toISOString()
    const due = listDueAutoposts(nowIso)
    lastTickAt = nowIso
    lastDueCount = due.length
    lastError = null
    if (due.length > 0) {
      logger.info('autopostScheduler: processing due posts', { count: due.length, ids: due.map((p) => p.id) })
    }
    for (const post of due) {
      await processDuePost(post)
    }
  } catch (err: unknown) {
    lastError = err instanceof Error ? err.message : String(err)
    logger.error('autopostScheduler: tick failed', { error: lastError })
  } finally {
    ticking = false
  }
}

/**
 * Планировщик автопостов: setInterval (AUTOPOST_TICK_MS, по умолчанию 15 с).
 */
export function startAutopostScheduler(): void {
  if (intervalHandle) {
    return
  }
  tickMs = getTickMs()
  startedAt = new Date().toISOString()
  const posts = listAutoposts()
  const active = posts.filter((p) => p.status === 'active').length
  intervalHandle = setInterval(() => {
    void tick()
  }, tickMs)
  void tick()
  logger.info('autopostScheduler: started', {
    tickMs,
    dbPath: POSTS_DB_PATH,
    totalPosts: posts.length,
    activePosts: active,
  })
}

export function stopAutopostScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}

/** Немедленный проход планировщика (после создания/обновления поста). */
export function triggerAutopostTick(): void {
  void tick()
}

export function getAutopostSchedulerStatus(): {
  running: boolean
  tickMs: number
  startedAt: string | null
  lastTickAt: string | null
  lastDueCount: number
  lastError: string | null
  dbPath: string
  totalPosts: number
  activePosts: number
  dueNow: number
  failedPosts: number
} {
  const posts = listAutoposts()
  const nowIso = new Date().toISOString()
  return {
    running: intervalHandle !== null,
    tickMs,
    startedAt,
    lastTickAt,
    lastDueCount,
    lastError,
    dbPath: POSTS_DB_PATH,
    totalPosts: posts.length,
    activePosts: posts.filter((p) => p.status === 'active').length,
    dueNow: listDueAutoposts(nowIso).length,
    failedPosts: posts.filter((p) => p.status === 'failed').length,
  }
}
