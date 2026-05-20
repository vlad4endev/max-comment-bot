import { getDb } from '../db/database'
import { compactUuidToStandard } from './startappPayload'

/** Telegram-style monotonic post id (decimal string, unique in `posts`). */
export function allocatePostId(): string {
  const db = getDb()
  const run = db.transaction(() => {
    const row = db.prepare('SELECT next_id FROM post_id_sequence WHERE id = 1').get() as
      | { next_id: number }
      | undefined
    const next = row?.next_id ?? 1
    db.prepare('UPDATE post_id_sequence SET next_id = ? WHERE id = 1').run(next + 1)
    return String(next)
  })
  return run()
}

/** Segment after `pid_` in MAX startapp: decimal id or 32-char UUID hex. */
export function parsePostIdFromStartappSegment(segment: string): string | null {
  const raw = segment.trim()
  if (!raw) {
    return null
  }
  if (/^\d+$/.test(raw)) {
    return raw
  }
  return compactUuidToStandard(raw)
}

/** Encodes `post_id` for `pid_<…>_cid_…` (numeric as-is, UUID without dashes). */
export function formatPostIdForStartapp(postId: string): string {
  const id = postId.trim()
  if (/^\d+$/.test(id)) {
    return id
  }
  return id.replace(/-/g, '')
}

export function isNumericPostId(postId: string): boolean {
  return /^\d+$/.test(postId.trim())
}
