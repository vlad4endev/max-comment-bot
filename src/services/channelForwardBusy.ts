import { resolveCanonicalChannelChatId } from './resolveChannelChatId'

const busyUntil = new Map<number, number>()

function canonicalChatId(chatId: number): number {
  return resolveCanonicalChannelChatId(chatId) ?? chatId
}

/** Поллер не дергает MAX, пока в этот канал идёт TG→MAX перенос. */
export function markChannelForwardBusy(chatId: number, holdMs: number = 45_000): void {
  const id = canonicalChatId(chatId)
  const until = Date.now() + Math.max(1_000, holdMs)
  const prev = busyUntil.get(id) ?? 0
  busyUntil.set(id, Math.max(prev, until))
}

export function isChannelForwardBusy(chatId: number): boolean {
  const until = busyUntil.get(canonicalChatId(chatId))
  return typeof until === 'number' && until > Date.now()
}
