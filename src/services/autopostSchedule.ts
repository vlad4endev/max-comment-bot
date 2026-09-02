const WEEKDAY_SHORT: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

export interface ZonedDateParts {
  year: number
  month: number
  day: number
  weekday: number
  hour: number
  minute: number
}

export function zonedParts(date: Date, timeZone: string): ZonedDateParts {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  })
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]))
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: WEEKDAY_SHORT[parts.weekday as string] ?? 0,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  }
}

/** Локальное время (Y-M-D H:M) в указанной IANA-зоне → UTC Date. */
export function zonedLocalToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0)
  for (let i = 0; i < 4; i += 1) {
    const actual = zonedParts(new Date(guess), timeZone)
    const targetMs = Date.UTC(year, month - 1, day, hour, minute, 0)
    const actualMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0)
    guess += targetMs - actualMs
  }
  return new Date(guess)
}

function addDaysInZone(
  base: Date,
  dayOffset: number,
  timeZone: string,
): { year: number; month: number; day: number; weekday: number } {
  const shifted = new Date(base.getTime() + dayOffset * 86_400_000)
  const parts = zonedParts(shifted, timeZone)
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    weekday: parts.weekday,
  }
}

export function parseTimeHm(raw: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim())
  if (!match) return null
  const hour = Number.parseInt(match[1], 10)
  const minute = Number.parseInt(match[2], 10)
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return { hour, minute }
}

export function formatTimeHm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function normalizeDailyTimes(times: unknown, fallback?: string | null): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: unknown) => {
    if (typeof raw !== 'string') return
    const parsed = parseTimeHm(raw)
    if (!parsed) return
    const key = formatTimeHm(parsed.hour, parsed.minute)
    if (seen.has(key)) return
    seen.add(key)
    out.push(key)
  }
  if (Array.isArray(times)) {
    for (const item of times) push(item)
  }
  if (!out.length && fallback) push(fallback)
  return out.sort()
}

export function parseYmd(raw: string | null | undefined): { year: number; month: number; day: number } | null {
  if (!raw) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim())
  if (!match) return null
  const year = Number.parseInt(match[1], 10)
  const month = Number.parseInt(match[2], 10)
  const day = Number.parseInt(match[3], 10)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return { year, month, day }
}

function ymdKey(year: number, month: number, day: number): number {
  return year * 10_000 + month * 100 + day
}

/** `YYYY-MM-DDTHH:MM` в timezone → ISO UTC. */
export function isoFromLocalDateTime(local: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/.exec(local.trim())
  if (!match) {
    throw new Error('scheduled_local must be YYYY-MM-DDTHH:MM')
  }
  const year = Number.parseInt(match[1], 10)
  const month = Number.parseInt(match[2], 10)
  const day = Number.parseInt(match[3], 10)
  const hour = Number.parseInt(match[4], 10)
  const minute = Number.parseInt(match[5], 10)
  if (hour > 23 || minute > 59) {
    throw new Error('scheduled_local has invalid time')
  }
  return zonedLocalToUtc(year, month, day, hour, minute, timeZone).toISOString()
}

export interface HoursRange {
  startMin: number
  endMin: number
}

/** "09:00-21:00" или "9-21". Конец не включительно, если равен началу — круглосуточно. */
export function parseHoursRange(raw: unknown): HoursRange | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const match = /(\d{1,2})(?::(\d{2}))?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?/.exec(raw.trim())
  if (!match) return null
  const startH = Number.parseInt(match[1], 10)
  const startM = Number.parseInt(match[2] || '0', 10)
  const endH = Number.parseInt(match[3], 10)
  const endM = Number.parseInt(match[4] || '0', 10)
  if (startH > 23 || endH > 23 || startM > 59 || endM > 59) return null
  return { startMin: startH * 60 + startM, endMin: endH * 60 + endM }
}

export function isMinuteInHoursRange(hour: number, minute: number, range: HoursRange): boolean {
  const cur = hour * 60 + minute
  if (range.startMin === range.endMin) return true
  if (range.startMin < range.endMin) {
    return cur >= range.startMin && cur < range.endMin
  }
  return cur >= range.startMin || cur < range.endMin
}

export interface NextOccurrenceInput {
  recurringTime?: string | null
  dailyTimes?: string[] | null
  weekdays: number[]
  timezone: string
  startDate?: string | null
  endDate?: string | null
  intervalHours?: number | null
  hoursRange?: HoursRange | null
  from?: Date
}

function startOfLocalDayUtc(ymd: { year: number; month: number; day: number }, timeZone: string): Date {
  return zonedLocalToUtc(ymd.year, ymd.month, ymd.day, 0, 0, timeZone)
}

function endOfLocalDayUtc(ymd: { year: number; month: number; day: number }, timeZone: string): Date {
  return zonedLocalToUtc(ymd.year, ymd.month, ymd.day, 23, 59, timeZone)
}

/**
 * Следующий слот публикации. null — серия закончилась (end_date / нет слотов).
 */
export function computeNextOccurrence(input: NextOccurrenceInput): string | null {
  const timeZone = input.timezone || 'Europe/Moscow'
  const from = input.from ?? new Date()
  const allowed = new Set(input.weekdays.filter((d) => d >= 0 && d <= 6))
  if (allowed.size === 0) {
    throw new Error('weekdays must not be empty for recurring schedule')
  }
  const start = parseYmd(input.startDate)
  const end = parseYmd(input.endDate)
  const times = normalizeDailyTimes(input.dailyTimes, input.recurringTime)
  if (!times.length && !(input.intervalHours && input.intervalHours > 0)) {
    throw new Error('recurring_time or daily_times required')
  }

  if (end) {
    const endUtc = endOfLocalDayUtc(end, timeZone)
    if (from.getTime() > endUtc.getTime()) return null
  }

  if (input.intervalHours && input.intervalHours > 0) {
    let candidate = new Date(from.getTime() + input.intervalHours * 3_600_000)
    if (start) {
      const startUtc = startOfLocalDayUtc(start, timeZone)
      if (candidate.getTime() < startUtc.getTime()) candidate = startUtc
    }
    for (let step = 0; step < 200; step += 1) {
      const parts = zonedParts(candidate, timeZone)
      if (!allowed.has(parts.weekday)) {
        candidate = new Date(candidate.getTime() + 60 * 60_000)
        continue
      }
      if (input.hoursRange && !isMinuteInHoursRange(parts.hour, parts.minute, input.hoursRange)) {
        candidate = new Date(candidate.getTime() + 15 * 60_000)
        continue
      }
      if (end) {
        const endUtc = endOfLocalDayUtc(end, timeZone)
        if (candidate.getTime() > endUtc.getTime()) return null
      }
      if (candidate.getTime() > from.getTime()) return candidate.toISOString()
      candidate = new Date(candidate.getTime() + 15 * 60_000)
    }
    return null
  }

  const parsedTimes = times
    .map((t) => parseTimeHm(t))
    .filter((t): t is { hour: number; minute: number } => t !== null)

  const MAX_DAYS = 400
  for (let dayOffset = 0; dayOffset <= MAX_DAYS; dayOffset += 1) {
    const local = addDaysInZone(from, dayOffset, timeZone)
    const key = ymdKey(local.year, local.month, local.day)
    if (start && key < ymdKey(start.year, start.month, start.day)) continue
    if (end && key > ymdKey(end.year, end.month, end.day)) return null
    if (!allowed.has(local.weekday)) continue
    for (const t of parsedTimes) {
      if (input.hoursRange && !isMinuteInHoursRange(t.hour, t.minute, input.hoursRange)) continue
      const candidate = zonedLocalToUtc(local.year, local.month, local.day, t.hour, t.minute, timeZone)
      if (candidate.getTime() > from.getTime()) return candidate.toISOString()
    }
  }
  return null
}

/**
 * Расчёт следующего запуска для периодических автопостов.
 * weekdays: 0 = воскресенье … 6 = суббота (как Date.getDay()).
 * recurring_time: "HH:MM" в timezone (по умолчанию Europe/Moscow).
 */
export function computeNextRecurringAt(
  recurringTime: string,
  weekdays: number[],
  from: Date = new Date(),
  timeZone = 'Europe/Moscow',
  dailyTimes?: string[] | null,
): string {
  const next = computeNextOccurrence({
    recurringTime,
    dailyTimes,
    weekdays,
    timezone: timeZone,
    from,
  })
  if (next) return next
  throw new Error(`could not compute next occurrence for ${recurringTime}`)
}

/** Из ISO datetime извлекает "HH:MM" для recurring_time (в timezone поста). */
export function extractRecurringTimeFromIso(iso: string, timeZone = 'Europe/Moscow'): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid scheduled_at: ${iso}`)
  }
  const parts = zonedParts(d, timeZone)
  return formatTimeHm(parts.hour, parts.minute)
}

/** Проверяет, наступило ли время публикации (независимо от формата ISO-строки). */
export function isAutopostDue(scheduledAt: string, now: Date = new Date()): boolean {
  const atMs = Date.parse(scheduledAt)
  if (!Number.isFinite(atMs)) {
    return false
  }
  return atMs <= now.getTime()
}

export function startOfTodayIso(timeZone: string, now: Date = new Date()): string {
  const parts = zonedParts(now, timeZone)
  return zonedLocalToUtc(parts.year, parts.month, parts.day, 0, 0, timeZone).toISOString()
}
