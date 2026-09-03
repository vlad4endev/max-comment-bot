import { logger } from '../utils/logger'

export type ChainTransferKind = 'tg_max' | 'tg_vk' | 'comments'
export type ChainTransferOutcome =
  | 'received'
  | 'success'
  | 'partial'
  | 'fail'
  | 'retry'
  | 'skip'
  | 'queue'

export interface ChainTransferEvent {
  ts: string
  kind: ChainTransferKind
  outcome: ChainTransferOutcome
  chainId: string
  title: string
  message: string
  messageIds?: number[]
  maxMid?: string | null
  attempts?: number
  lagMs?: number
  error?: string
  queueDepth?: number
  oldestWaitMs?: number
}

const MAX_EVENTS = 400
const events: ChainTransferEvent[] = []

function kindLabel(kind: ChainTransferKind): string {
  if (kind === 'tg_vk') return 'TG→VK'
  if (kind === 'comments') return 'комментарии'
  return 'TG→MAX'
}

function formatMessageIds(ids: number[] | undefined): string {
  if (!ids || ids.length === 0) {
    return 'пост'
  }
  if (ids.length === 1) {
    return `пост ${ids[0]}`
  }
  const sorted = [...ids].sort((a, b) => a - b)
  return `посты ${sorted[0]}–${sorted[sorted.length - 1]}`
}

function formatLag(lagMs: number | undefined): string {
  if (lagMs == null || !Number.isFinite(lagMs) || lagMs < 0) {
    return ''
  }
  if (lagMs < 1000) {
    return ' · задержка <1 с'
  }
  if (lagMs < 60_000) {
    return ` · задержка ${Math.round(lagMs / 1000)} с`
  }
  return ` · задержка ${Math.round(lagMs / 60_000)} мин`
}

function formatWait(waitMs: number | undefined): string {
  if (waitMs == null || !Number.isFinite(waitMs) || waitMs < 0) {
    return ''
  }
  if (waitMs < 60_000) {
    return `${Math.max(1, Math.round(waitMs / 1000))} с`
  }
  return `${Math.round(waitMs / 60_000)} мин`
}

function clipError(err: string | undefined): string | undefined {
  if (!err) {
    return undefined
  }
  return err.replace(/\s+/g, ' ').trim().slice(0, 280)
}

export function tgChainDisplayName(chain: {
  id: string
  max_title?: string | null
  tg_username?: string
}): string {
  const title = chain.max_title?.trim()
  if (title) {
    return title
  }
  const username = chain.tg_username?.trim()
  if (username) {
    return `@${username.replace(/^@/, '')}`
  }
  return `цепочка ${chain.id.slice(0, 8)}`
}

export function vkChainDisplayName(chain: {
  id: string
  vk_name?: string | null
  vk_group_id?: string
}): string {
  const name = chain.vk_name?.trim()
  if (name) {
    return name
  }
  const groupId = chain.vk_group_id?.trim()
  if (groupId) {
    return `VK ${groupId}`
  }
  return `VK ${chain.id.slice(0, 8)}`
}

function buildLogLine(event: ChainTransferEvent): string {
  const title = event.title.trim() || event.chainId.slice(0, 8)
  const who = event.chainId === '*' ? '' : ` «${title}»: `
  if (event.outcome === 'queue') {
    return `[цепочка] ${event.message}`
  }
  return `[цепочка] ${kindLabel(event.kind)}${who}${event.message}`
}

function extraPayload(event: ChainTransferEvent): Record<string, unknown> {
  return {
    scope: 'chain',
    kind: event.kind,
    outcome: event.outcome,
    chainId: event.chainId === '*' ? undefined : event.chainId,
    title: event.title,
    messageIds: event.messageIds,
    maxMid: event.maxMid ?? undefined,
    attempts: event.attempts,
    lagMs: event.lagMs,
    error: event.error,
    queueDepth: event.queueDepth,
    oldestWaitMs: event.oldestWaitMs,
  }
}

export function recordChainTransfer(
  input: Omit<ChainTransferEvent, 'ts' | 'message'> & { message: string },
): ChainTransferEvent {
  const event: ChainTransferEvent = {
    ...input,
    ts: new Date().toISOString(),
    error: clipError(input.error),
    message: input.message.trim(),
  }
  events.push(event)
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS)
  }

  const line = buildLogLine(event)
  const extra = extraPayload(event)
  if (event.outcome === 'fail') {
    logger.error(line, extra)
  } else if (event.outcome === 'retry' || event.outcome === 'partial' || event.outcome === 'queue') {
    const warnQueue =
      event.outcome === 'queue' &&
      ((event.oldestWaitMs ?? 0) >= 5 * 60_000 || (event.queueDepth ?? 0) >= 8)
    if (event.outcome === 'retry' || event.outcome === 'partial' || warnQueue) {
      logger.warn(line, extra)
    } else {
      logger.info(line, extra)
    }
  } else {
    logger.info(line, extra)
  }
  return event
}

export function recordTgMaxSuccess(input: {
  chainId: string
  title: string
  messageIds: number[]
  published: number
  album: boolean
  maxMid?: string | null
  lagMs?: number
}): void {
  const posts = formatMessageIds(input.messageIds)
  const albumBit = input.album ? 'альбом ' : ''
  const midBit = input.maxMid ? ` → MAX ${input.maxMid}` : ''
  const countBit = input.published > 1 ? ` (${input.published} сообщений)` : ''
  recordChainTransfer({
    kind: 'tg_max',
    outcome: 'success',
    chainId: input.chainId,
    title: input.title,
    messageIds: input.messageIds,
    maxMid: input.maxMid,
    lagMs: input.lagMs,
    message: `${albumBit}${posts} опубликован${countBit}${midBit}${formatLag(input.lagMs)}`,
  })
}

export function recordTgMaxFail(input: {
  chainId: string
  title: string
  messageIds: number[]
  error: string
  attempts?: number
}): void {
  const posts = formatMessageIds(input.messageIds)
  const attemptBit = input.attempts ? ` (попытка ${input.attempts})` : ''
  recordChainTransfer({
    kind: 'tg_max',
    outcome: 'fail',
    chainId: input.chainId,
    title: input.title,
    messageIds: input.messageIds,
    attempts: input.attempts,
    error: input.error,
    message: `${posts} не перенесён${attemptBit} — ${clipError(input.error) || 'ошибка публикации'}`,
  })
}

export function recordTgMaxRetry(input: {
  chainId: string
  title: string
  messageIds: number[]
  error: string
  attempts: number
  queueDepth?: number
}): void {
  const posts = formatMessageIds(input.messageIds)
  recordChainTransfer({
    kind: 'tg_max',
    outcome: 'retry',
    chainId: input.chainId,
    title: input.title,
    messageIds: input.messageIds,
    attempts: input.attempts,
    error: input.error,
    queueDepth: input.queueDepth,
    message: `${posts} не опубликован, повтор (попытка ${input.attempts}) — ${clipError(input.error) || 'публикация не завершена'}`,
  })
}

export function recordTgMaxSkip(input: {
  chainId: string
  title: string
  messageId: number
  reason: string
}): void {
  recordChainTransfer({
    kind: 'tg_max',
    outcome: 'skip',
    chainId: input.chainId,
    title: input.title,
    messageIds: [input.messageId],
    message: `пост ${input.messageId} пропущен — ${input.reason}`,
  })
}

export function recordTgMaxReceived(input: {
  chainId: string
  title: string
  messageIds: number[]
  lagMs?: number
}): void {
  recordChainTransfer({
    kind: 'tg_max',
    outcome: 'received',
    chainId: input.chainId,
    title: input.title,
    messageIds: input.messageIds,
    lagMs: input.lagMs,
    message: `получен ${formatMessageIds(input.messageIds)} из Telegram${formatLag(input.lagMs)}`,
  })
}

export function recordTgMaxPartial(input: {
  chainId: string
  title: string
  messageIds: number[]
  published: number
  remaining: number
}): void {
  recordChainTransfer({
    kind: 'tg_max',
    outcome: 'partial',
    chainId: input.chainId,
    title: input.title,
    messageIds: input.messageIds,
    message: `частичный перенос: опубликовано ${input.published}, осталось ${input.remaining}`,
  })
}

export function recordVkSuccess(input: {
  chainId: string
  title: string
  maxMid: string
  vkPostId: number
}): void {
  recordChainTransfer({
    kind: 'tg_vk',
    outcome: 'success',
    chainId: input.chainId,
    title: input.title,
    maxMid: input.maxMid,
    message: `пост опубликован на стену VK (vk ${input.vkPostId})`,
  })
}

export function recordVkFail(input: {
  chainId: string
  title: string
  maxMid: string
  error: string
}): void {
  recordChainTransfer({
    kind: 'tg_vk',
    outcome: 'fail',
    chainId: input.chainId,
    title: input.title,
    maxMid: input.maxMid,
    error: input.error,
    message: `не удалось опубликовать в VK — ${clipError(input.error) || 'ошибка'}`,
  })
}

export function recordCommentSuccess(input: {
  chainId: string
  title: string
  messageId: number
}): void {
  recordChainTransfer({
    kind: 'comments',
    outcome: 'success',
    chainId: input.chainId,
    title: input.title,
    messageIds: [input.messageId],
    message: `комментарий TG ${input.messageId} перенесён`,
  })
}

export function recordCommentRetry(input: {
  chainId: string
  title: string
  messageId?: number
  error: string
  attempts: number
}): void {
  recordChainTransfer({
    kind: 'comments',
    outcome: 'retry',
    chainId: input.chainId,
    title: input.title,
    messageIds: input.messageId != null ? [input.messageId] : undefined,
    attempts: input.attempts,
    error: input.error,
    message: `комментарий не перенесён, повтор (попытка ${input.attempts}) — ${clipError(input.error) || 'ожидание'}`,
  })
}

export function recordCommentSkip(input: {
  chainId: string
  title: string
  messageId: number
  reason: string
}): void {
  recordChainTransfer({
    kind: 'comments',
    outcome: 'skip',
    chainId: input.chainId,
    title: input.title,
    messageIds: [input.messageId],
    message: `комментарий ${input.messageId} пропущен — ${input.reason}`,
  })
}

export function recordQueueSnapshot(input: {
  posts: number
  comments: number
  oldestWaitMs: number | null
  stuck: number
}): void {
  if (input.posts <= 0 && input.comments <= 0) {
    recordChainTransfer({
      kind: 'tg_max',
      outcome: 'queue',
      chainId: '*',
      title: 'все цепочки',
      queueDepth: 0,
      oldestWaitMs: 0,
      message: 'очередь переноса пуста — заторов нет',
    })
    return
  }
  const wait = input.oldestWaitMs != null ? `, старейшая задача ${formatWait(input.oldestWaitMs)}` : ''
  const stuck = input.stuck > 0 ? `, застряло ${input.stuck}` : ''
  recordChainTransfer({
    kind: 'tg_max',
    outcome: 'queue',
    chainId: '*',
    title: 'все цепочки',
    queueDepth: input.posts + input.comments,
    oldestWaitMs: input.oldestWaitMs ?? undefined,
    message: `накопление очереди: ${input.posts} постов, ${input.comments} комментариев${wait}${stuck}`,
  })
}

export function listChainTransferEvents(limit = 80): ChainTransferEvent[] {
  const n = Math.min(Math.max(1, limit), MAX_EVENTS)
  return events.slice(-n)
}
