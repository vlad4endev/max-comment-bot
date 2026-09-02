import {
  computeNextOccurrence,
  isMinuteInHoursRange,
  parseHoursRange,
  startOfTodayIso,
  zonedParts,
  type HoursRange,
} from './autopostSchedule'
import {
  countSuccessfulPublishesSince,
  getPostChannel,
  type AutopostCondition,
  type AutopostRecord,
} from './autopostStore'

export interface AutopostGateResult {
  ok: boolean
  reason?: string
  retryAt?: string
}

function conditionValue(conditions: AutopostCondition[], type: AutopostCondition['type']): string | number | null {
  const row = conditions.find((c) => c.type === type)
  return row ? row.value : null
}

export function hoursRangeFromPost(post: AutopostRecord): HoursRange | null {
  return parseHoursRange(conditionValue(post.conditions, 'hours_range'))
}

export function nextSlotForPost(post: AutopostRecord, from: Date = new Date()): string | null {
  if (post.schedule_type !== 'recurring') return null
  const weekdays = post.weekdays?.length ? post.weekdays : [0, 1, 2, 3, 4, 5, 6]
  return computeNextOccurrence({
    recurringTime: post.recurring_time,
    dailyTimes: post.daily_times,
    weekdays,
    timezone: post.timezone || 'Europe/Moscow',
    startDate: post.start_date,
    endDate: post.end_date,
    intervalHours: post.interval_hours,
    hoursRange: hoursRangeFromPost(post),
    from,
  })
}

function parsePositiveNumber(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''))
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

/**
 * Проверяет лимит повторов, окно дат и условия перед отправкой.
 * retryAt — когда можно попробовать снова (для skip слота).
 */
export function evaluateAutopostGate(post: AutopostRecord, now: Date = new Date()): AutopostGateResult {
  if (post.repeat_limit != null && post.repeat_limit > 0 && post.sent_count >= post.repeat_limit) {
    return { ok: false, reason: `Достигнут лимит повторов (${post.repeat_limit})` }
  }

  const tz = post.timezone || 'Europe/Moscow'
  const parts = zonedParts(now, tz)
  const todayKey = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
  if (post.start_date && todayKey < post.start_date.slice(0, 10)) {
    const retryAt = nextSlotForPost(post, now)
    return { ok: false, reason: 'Серия ещё не началась', retryAt: retryAt ?? undefined }
  }
  if (post.end_date && todayKey > post.end_date.slice(0, 10)) {
    return { ok: false, reason: 'Серия закончилась по дате окончания' }
  }

  const range = hoursRangeFromPost(post)
  if (range && !isMinuteInHoursRange(parts.hour, parts.minute, range)) {
    const retryAt = nextSlotForPost(post, now)
    return { ok: false, reason: 'Вне разрешённого окна часов', retryAt: retryAt ?? undefined }
  }

  for (const cond of post.conditions) {
    if (cond.type === 'min_interval_hours' && post.last_sent_at) {
      const hours = parsePositiveNumber(cond.value)
      if (hours) {
        const last = Date.parse(post.last_sent_at)
        const readyAt = last + hours * 3_600_000
        if (Number.isFinite(last) && now.getTime() < readyAt) {
          return {
            ok: false,
            reason: `Минимальный интервал ${hours} ч ещё не прошёл`,
            retryAt: new Date(readyAt).toISOString(),
          }
        }
      }
    }
    if (cond.type === 'max_posts_per_day') {
      const max = parsePositiveNumber(cond.value)
      if (max) {
        const since = startOfTodayIso(tz, now)
        const sent = countSuccessfulPublishesSince(post.platform, post.target_channel_id, since)
        if (sent >= max) {
          const retryAt = nextSlotForPost(post, new Date(now.getTime() + 60 * 60_000))
          return {
            ok: false,
            reason: `Лимит публикаций в канале за день (${max})`,
            retryAt: retryAt ?? undefined,
          }
        }
      }
    }
    if (cond.type === 'min_subscribers') {
      const min = parsePositiveNumber(cond.value)
      if (min) {
        const ch = getPostChannel(post.platform, post.target_channel_id)
        const count = ch?.subscribers_count ?? 0
        if (count > 0 && count < min) {
          return { ok: false, reason: `Подписчиков ${count}, нужно минимум ${min}` }
        }
      }
    }
    if (cond.type === 'weekdays_only' && post.weekdays?.length) {
      if (!post.weekdays.includes(parts.weekday)) {
        const retryAt = nextSlotForPost(post, now)
        return { ok: false, reason: 'Сегодня не в выбранных днях недели', retryAt: retryAt ?? undefined }
      }
    }
  }

  return { ok: true }
}
