export type AdminActivityType =
  | 'new_subscriber'
  | 'new_comment'
  | 'new_post_button'
  | 'admin_reply'
  | 'channel_added'

export interface AdminActivityEvent {
  type: AdminActivityType
  timestamp: string
  payload: Record<string, unknown>
}

const MAX_EVENTS = 100
const events: AdminActivityEvent[] = []

export function pushAdminActivity(
  type: AdminActivityType,
  payload: Record<string, unknown> = {},
): void {
  events.unshift({
    type,
    timestamp: new Date().toISOString(),
    payload,
  })
  if (events.length > MAX_EVENTS) {
    events.length = MAX_EVENTS
  }
}

export function getRecentAdminActivity(limit: number): AdminActivityEvent[] {
  const n = Math.min(Math.max(0, limit), events.length)
  return events.slice(0, n)
}
