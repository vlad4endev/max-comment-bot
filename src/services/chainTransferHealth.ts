import { getDb } from '../db/database'
import { listTgChainsSync, listVkChainsSync } from '../api/adminPanelState'
import {
  listChainTransferEvents,
  tgChainDisplayName,
  vkChainDisplayName,
  type ChainTransferEvent,
} from './chainTransferLog'
import { getTgChainForwarderRuntime } from './tgChainForwarder'
import {
  countCommentInboundJobs,
  countForwardQueueJobs,
  listCommentInboundJobViews,
  listForwardQueueJobViews,
  summarizeCommentQueueByChain,
  summarizeForwardQueueByChain,
  type CommentQueueJobView,
  type ForwardQueueJobView,
} from './tgChainForwardQueue'

export type ChainHealthStatus =
  | 'ok'
  | 'queueing'
  | 'delayed'
  | 'stuck'
  | 'failing'
  | 'silent'
  | 'paused'
  | 'idle'

export type ChainHealthRow = {
  id: string
  kind: 'tg_max' | 'tg_vk'
  title: string
  source: string
  target: string
  active: boolean
  forward_posts: boolean
  status: ChainHealthStatus
  status_label: string
  forwarded_today: number
  errors_today: number
  last_forwarded_at: string | null
  last_activity_at: string | null
  queue_posts: number
  queue_comments: number
  oldest_wait_ms: number | null
  last_error: string | null
}

export type ChainTransferHealthSnapshot = {
  health: 'ok' | 'attention' | 'critical'
  health_label: string
  poll_loops: number
  in_flight_forwards: number
  in_flight_comments: number
  album_buffer: number
  queue_posts: number
  queue_comments: number
  forwarded_today: number
  errors_today: number
  active_chains: number
  chains: ChainHealthRow[]
  queues: {
    posts: ForwardQueueJobView[]
    comments: CommentQueueJobView[]
  }
  events: ChainTransferEvent[]
  generated_at: string
}

const STATUS_LABEL: Record<ChainHealthStatus, string> = {
  ok: 'Работает',
  queueing: 'Очередь',
  delayed: 'Задержка',
  stuck: 'Застряла',
  failing: 'Ошибки',
  silent: 'Тишина',
  paused: 'На паузе',
  idle: 'Перенос выкл.',
}

function getLastForwardedAt(chainId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT MAX(forwarded_at) AS last_forwarded_at
       FROM tg_chain_forwarded
       WHERE chain_id = ?
         AND max_message_mid IS NOT NULL
         AND TRIM(max_message_mid) != ''
         AND max_message_mid != '__skipped__'`,
    )
    .get(chainId) as { last_forwarded_at: string | null } | undefined
  return row?.last_forwarded_at ?? null
}

function waitMs(createdAt: number | null | undefined, now: number): number | null {
  if (createdAt == null || !Number.isFinite(createdAt) || createdAt <= 0) {
    return null
  }
  return Math.max(0, now - createdAt)
}

function decideTgStatus(input: {
  active: boolean
  forwardPosts: boolean
  forwardComments: boolean
  queuePosts: number
  maxAttempts: number
  oldestWaitMs: number | null
  errorsToday: number
  forwardedToday: number
  lastActivityMs: number | undefined
  pollLoops: number
  now: number
}): ChainHealthStatus {
  if (!input.active) {
    return 'paused'
  }
  if (!input.forwardPosts && !input.forwardComments) {
    return 'idle'
  }
  if (input.maxAttempts >= 6) {
    return 'stuck'
  }
  if ((input.oldestWaitMs ?? 0) >= 2 * 60_000) {
    return 'delayed'
  }
  if (input.errorsToday > 0 && input.forwardedToday === 0) {
    return 'failing'
  }
  if (input.queuePosts > 0) {
    return 'queueing'
  }
  if (input.forwardPosts && input.pollLoops === 0) {
    return 'silent'
  }
  if (
    input.forwardPosts &&
    input.pollLoops > 0 &&
    input.lastActivityMs != null &&
    input.now - input.lastActivityMs > 2 * 60_000
  ) {
    return 'silent'
  }
  return 'ok'
}

function decideVkStatus(input: {
  active: boolean
  forwardPosts: boolean
  errorsToday: number
  forwardedToday: number
}): ChainHealthStatus {
  if (!input.active) {
    return 'paused'
  }
  if (!input.forwardPosts) {
    return 'idle'
  }
  if (input.errorsToday > 0 && input.forwardedToday === 0) {
    return 'failing'
  }
  if (input.errorsToday > 0) {
    return 'queueing'
  }
  return 'ok'
}

export function getChainTransferHealthSnapshot(): ChainTransferHealthSnapshot {
  const now = Date.now()
  const runtime = getTgChainForwarderRuntime()
  const postQueue = summarizeForwardQueueByChain()
  const commentQueue = summarizeCommentQueueByChain()
  const postJobs = listForwardQueueJobViews(40)
  const commentJobs = listCommentInboundJobViews(40)

  const tgChains = listTgChainsSync()
  const vkChains = listVkChainsSync()

  const tgRows: ChainHealthRow[] = tgChains.map((chain) => {
    const q = postQueue.get(chain.id)
    const cq = commentQueue.get(chain.id)
    const oldestWait = waitMs(q?.oldestCreatedAt ?? cq?.oldestCreatedAt ?? null, now)
    const status = decideTgStatus({
      active: chain.active,
      forwardPosts: chain.forward_posts,
      forwardComments: chain.forward_comments,
      queuePosts: q?.count ?? 0,
      maxAttempts: Math.max(q?.maxAttempts ?? 0, cq?.maxAttempts ?? 0),
      oldestWaitMs: oldestWait,
      errorsToday: chain.errors_today ?? 0,
      forwardedToday: chain.forwarded_today ?? 0,
      lastActivityMs: runtime.last_activity[chain.id],
      pollLoops: runtime.poll_loops,
      now,
    })
    const lastActivityMs = runtime.last_activity[chain.id]
    const tgName = chain.tg_username?.trim()
      ? `@${chain.tg_username.replace(/^@/, '')}`
      : chain.tg_channel_id || 'Telegram'
    return {
      id: chain.id,
      kind: 'tg_max',
      title: tgChainDisplayName(chain),
      source: tgName,
      target: chain.max_title?.trim() || String(chain.max_chat_id),
      active: chain.active,
      forward_posts: chain.forward_posts,
      status,
      status_label: STATUS_LABEL[status],
      forwarded_today: chain.forwarded_today ?? 0,
      errors_today: chain.errors_today ?? 0,
      last_forwarded_at: getLastForwardedAt(chain.id),
      last_activity_at: lastActivityMs ? new Date(lastActivityMs).toISOString() : null,
      queue_posts: q?.count ?? 0,
      queue_comments: cq?.count ?? 0,
      oldest_wait_ms: oldestWait,
      last_error: q?.lastError ?? cq?.lastError ?? null,
    }
  })

  const vkRows: ChainHealthRow[] = vkChains.map((chain) => {
    const status = decideVkStatus({
      active: chain.active !== false,
      forwardPosts: chain.forward_posts !== false,
      errorsToday: chain.errors_today ?? 0,
      forwardedToday: chain.forwarded_today ?? 0,
    })
    return {
      id: chain.id,
      kind: 'tg_vk',
      title: vkChainDisplayName(chain),
      source: 'Telegram',
      target: vkChainDisplayName(chain),
      active: chain.active !== false,
      forward_posts: chain.forward_posts !== false,
      status,
      status_label: STATUS_LABEL[status],
      forwarded_today: chain.forwarded_today ?? 0,
      errors_today: chain.errors_today ?? 0,
      last_forwarded_at: null,
      last_activity_at: null,
      queue_posts: 0,
      queue_comments: 0,
      oldest_wait_ms: null,
      last_error: null,
    }
  })

  const chains = [...tgRows, ...vkRows]
  const activeForwarding = tgChains.filter((c) => c.active && c.forward_posts).length
  const hasStuck = chains.some((c) => c.status === 'stuck')
  const hasProblem = chains.some(
    (c) =>
      c.status === 'delayed' ||
      c.status === 'failing' ||
      c.status === 'silent' ||
      c.status === 'queueing',
  )
  const pollDown = activeForwarding > 0 && runtime.poll_loops === 0
  const health: ChainTransferHealthSnapshot['health'] = hasStuck || pollDown ? 'critical' : hasProblem ? 'attention' : 'ok'
  const healthLabel = pollDown
    ? 'Опрос Telegram не запущен — перенос не работает'
    : hasStuck
      ? 'Есть застрявшие задачи в очереди'
      : hasProblem
        ? 'Перенос работает с задержками или ошибками'
        : activeForwarding > 0
          ? 'Перенос постов работает'
          : 'Нет активных цепочек с переносом постов'

  const forwardedToday = chains.reduce((s, c) => s + c.forwarded_today, 0)
  const errorsToday = chains.reduce((s, c) => s + c.errors_today, 0)

  return {
    health,
    health_label: healthLabel,
    poll_loops: runtime.poll_loops,
    in_flight_forwards: runtime.in_flight_forwards,
    in_flight_comments: runtime.in_flight_comments,
    album_buffer: runtime.album_buffer,
    queue_posts: countForwardQueueJobs(),
    queue_comments: countCommentInboundJobs(),
    forwarded_today: forwardedToday,
    errors_today: errorsToday,
    active_chains: tgChains.filter((c) => c.active).length + vkChains.filter((c) => c.active !== false).length,
    chains,
    queues: { posts: postJobs, comments: commentJobs },
    events: listChainTransferEvents(60),
    generated_at: new Date().toISOString(),
  }
}

export function getChainTransferHealthSummary(): {
  health: ChainTransferHealthSnapshot['health']
  queue_posts: number
  queue_comments: number
  forwarded_today: number
  errors_today: number
  stuck: string[]
} {
  const snap = getChainTransferHealthSnapshot()
  return {
    health: snap.health,
    queue_posts: snap.queue_posts,
    queue_comments: snap.queue_comments,
    forwarded_today: snap.forwarded_today,
    errors_today: snap.errors_today,
    stuck: snap.chains.filter((c) => c.status === 'stuck' || c.status === 'delayed').map((c) => c.title),
  }
}
