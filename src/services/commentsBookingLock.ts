/**
 * TTL кросс-платформенной брони: сколько часов комментарии в MAX закрыты
 * после первого комментария из Telegram / VK.
 */

const DEFAULT_COMMENTS_BOOKING_LOCK_HOURS = 8

export type CommentsBookingLockFields = {
  comments_booked_by?: 'telegram' | 'max' | 'vk'
  comments_booked_at?: string
}

/** Сколько часов комментарии в MAX закрыты после брони TG/VK. */
export function getCommentsBookingLockHours(): number {
  const raw = (process.env.COMMENTS_BOOKING_LOCK_HOURS ?? '').trim()
  if (raw === '') return DEFAULT_COMMENTS_BOOKING_LOCK_HOURS
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_COMMENTS_BOOKING_LOCK_HOURS
  return Math.min(parsed, 24 * 30)
}

export function getCommentsBookingLockMs(): number {
  return getCommentsBookingLockHours() * 60 * 60 * 1000
}

/**
 * Бронь ещё действует (закрытие MAX + блокировка кросс-синхронизации).
 * Посты без `comments_booked_at` (до введения TTL) считаются уже истекшими —
 * комментарии в MAX снова доступны.
 */
export function isCommentsBookingActive(
  post: CommentsBookingLockFields,
  nowMs: number = Date.now(),
): boolean {
  if (!post.comments_booked_by) {
    return false
  }
  if (!post.comments_booked_at) {
    return false
  }
  const bookedAt = Date.parse(post.comments_booked_at)
  if (!Number.isFinite(bookedAt)) {
    return false
  }
  return nowMs - bookedAt < getCommentsBookingLockMs()
}

/** ISO-время, до которого в MAX закрыты комментарии (если бронь TG/VK активна). */
export function commentsClosedUntilIso(post: CommentsBookingLockFields): string | null {
  if (post.comments_booked_by !== 'telegram' && post.comments_booked_by !== 'vk') {
    return null
  }
  if (!isCommentsBookingActive(post)) {
    return null
  }
  if (!post.comments_booked_at) {
    return null
  }
  const bookedAt = Date.parse(post.comments_booked_at)
  if (!Number.isFinite(bookedAt)) {
    return null
  }
  return new Date(bookedAt + getCommentsBookingLockMs()).toISOString()
}
