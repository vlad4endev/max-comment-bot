import { getTelegramToken } from '../config'
import { logger } from '../utils/logger'
import { integrationsStore } from './integrationsStore'
import { computeNextRecurringAt } from './autopostSchedule'
import {
  listDueAutoposts,
  markAutopostFailed,
  markAutopostSent,
  type AutopostRecord,
} from './autopostStore'
import { sendAutopostToTelegram } from './autopostTelegramSender'

const DEFAULT_TICK_MS = 60_000

let intervalHandle: ReturnType<typeof setInterval> | null = null
let ticking = false

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

async function processDuePost(post: AutopostRecord, token: string): Promise<void> {
  try {
    const result = await sendAutopostToTelegram(token, post)
    if (result.warning) {
      logger.info('autopostScheduler: sent with notice', { id: post.id, warning: result.warning })
    }

    if (post.schedule_type === 'once') {
      markAutopostSent(post.id, { status: 'sent' })
      logger.info('autopostScheduler: one-time post sent', { id: post.id, channel: post.target_channel_id })
      return
    }

    const recurringTime = post.recurring_time
    const weekdays = post.weekdays
    if (!recurringTime || !weekdays?.length) {
      markAutopostFailed(post.id, 'recurring schedule misconfigured')
      return
    }
    const nextAt = computeNextRecurringAt(recurringTime, weekdays)
    markAutopostSent(post.id, { nextScheduledAt: nextAt, status: 'active' })
    logger.info('autopostScheduler: recurring post sent, next scheduled', {
      id: post.id,
      nextAt,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    markAutopostFailed(post.id, message)
    logger.error('autopostScheduler: send failed', { id: post.id, error: message })
  }
}

async function tick(): Promise<void> {
  if (ticking) {
    return
  }
  ticking = true
  try {
    const token = resolveTelegramToken()
    if (!token) {
      return
    }
    const nowIso = new Date().toISOString()
    const due = listDueAutoposts(nowIso)
    for (const post of due) {
      await processDuePost(post, token)
    }
  } finally {
    ticking = false
  }
}

/**
 * Планировщик автопостов: setInterval раз в минуту (AUTOPOST_TICK_MS).
 * В проекте уже используются setInterval-воркеры (channelPoller, flowProcessor) —
 * отдельный node-cron/BullMQ не нужен для одного тика в минуту.
 */
export function startAutopostScheduler(): void {
  if (intervalHandle) {
    return
  }
  const tickMs = getTickMs()
  intervalHandle = setInterval(() => {
    void tick()
  }, tickMs)
  void tick()
  logger.info('autopostScheduler: started', { tickMs })
}

export function stopAutopostScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}
