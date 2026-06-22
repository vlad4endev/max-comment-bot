/**
 * Диагностика и восстановление синхронизации комментариев MAX ↔ Telegram.
 */

import axios from 'axios'

import { listTgChainsSync, type TgChainRecord } from '../api/adminPanelState'
import { getDb } from '../db/database'
import { parseAdminLogLine, type AdminLogEntry } from '../utils/adminLogFormat'
import { getAdminLogTail, logger } from '../utils/logger'
import {
  isInvalidTelegramMessageIdError,
  isSendAsPeerInvalidError,
  isTelegramForbiddenError,
  isTelegramUnauthorizedError,
} from '../utils/telegramSyncErrors'
import {
  countPostMappingThreadStats,
  countMappingChannelIdMismatch,
  listMappingsMissingThread,
  resolveDiscussionChatId,
  backfillPostCommentMappingsFromForwarded,
} from './postCommentMappingStore'
import { ensurePostThreadMapping } from './telegramDiscussionThreadResolver'
import { isMtprotoSessionReady, resolveMtprotoCredentials } from './mtprotoConfigStore'
import { resolveTelegramBotToken } from './resolveTelegramBotToken'
import { getTelegramApiMinIntervalMs } from '../utils/telegramRateLimiter'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const TG_API = 'https://api.telegram.org'

export type CommentSyncIssueSeverity = 'critical' | 'warning' | 'info'

export interface CommentSyncIssue {
  severity: CommentSyncIssueSeverity
  code: string
  title: string
  description: string
  what_to_do: string
}

export interface CommentSyncChainDiagnostics {
  chain_id: string
  chain_name: string
  active: boolean
  forward_comments: boolean
  discussion_chat_id: number | null
  discussion_linked: boolean
  bot_channel_admin: boolean | null
  bot_discussion_member: boolean | null
  mtproto_ready: boolean
  send_as_mode: 'channel' | 'chat'
  mapping_stats: {
    total: number
    with_thread: number
    missing_thread: number
  }
  pending_max_to_tg: number
  issues: CommentSyncIssue[]
}

export interface CommentSyncDiagnosticsReport {
  checked_at: string
  chains: CommentSyncChainDiagnostics[]
  log_signals_24h: {
    invalid_message_id: number
    send_as_peer_invalid: number
    forbidden: number
    unauthorized: number
    flood_wait: number
    no_thread_mapping: number
  }
  recommendations: string[]
}

function resolveBotTokenForChain(chain: TgChainRecord): string {
  const fromChain = chain.bot_token?.trim()
  if (fromChain) {
    return fromChain
  }
  return resolveTelegramBotToken()
}

async function getBotUserId(token: string): Promise<number | null> {
  try {
    const { data } = await axios.get<{ ok: boolean; result?: { id?: number } }>(
      `${TG_API}/bot${token}/getMe`,
      { timeout: 10_000 },
    )
    const id = data.result?.id
    return typeof id === 'number' && id > 0 ? id : null
  } catch {
    return null
  }
}

async function isBotChatAdmin(token: string, chatId: string | number, botId: number): Promise<boolean> {
  try {
    const { data } = await axios.get<{ ok: boolean; result?: { status?: string } }>(
      `${TG_API}/bot${token}/getChatMember`,
      {
        params: { chat_id: chatId, user_id: botId },
        timeout: 15_000,
      },
    )
    const status = data.result?.status ?? ''
    return status === 'administrator' || status === 'creator'
  } catch {
    return false
  }
}

async function isBotChatMember(token: string, chatId: number, botId: number): Promise<boolean> {
  try {
    const { data } = await axios.get<{ ok: boolean; result?: { status?: string } }>(
      `${TG_API}/bot${token}/getChatMember`,
      {
        params: { chat_id: chatId, user_id: botId },
        timeout: 15_000,
      },
    )
    const status = data.result?.status ?? ''
    return status !== 'left' && status !== 'kicked' && status !== ''
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (isTelegramForbiddenError(msg)) {
      return false
    }
    return false
  }
}

function resolveChannelChatId(chain: TgChainRecord): string | null {
  const fromId = chain.tg_channel_id?.trim()
  if (fromId) {
    return fromId
  }
  const username = chain.tg_username?.trim()
  if (username) {
    return username.startsWith('@') ? username : `@${username}`
  }
  return null
}

function countPendingMaxToTelegram(maxChatId: number): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n
       FROM comments c
       JOIN posts p ON p.post_id = c.post_id
       WHERE ABS(p.chat_id) = ?
         AND (c.source IS NULL OR c.source = 'max')
         AND (c.tg_comment_id IS NULL OR c.tg_comment_id = 0)`,
    )
    .get(Math.abs(maxChatId)) as { n: number }
  return Number(row.n) || 0
}

function analyzeLogSignals(entries: AdminLogEntry[]): CommentSyncDiagnosticsReport['log_signals_24h'] {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  let invalid_message_id = 0
  let send_as_peer_invalid = 0
  let forbidden = 0
  let unauthorized = 0
  let flood_wait = 0
  let no_thread_mapping = 0

  for (const entry of entries) {
    if (entry.ts) {
      const ts = Date.parse(entry.ts)
      if (Number.isFinite(ts) && ts < cutoff) {
        continue
      }
    }
    const hay = `${entry.message} ${entry.raw}`.toLowerCase()
    if (hay.includes('no thread mapping')) {
      no_thread_mapping += 1
    }
    if (isInvalidTelegramMessageIdError(hay)) {
      invalid_message_id += 1
    }
    if (isSendAsPeerInvalidError(hay)) {
      send_as_peer_invalid += 1
    }
    if (isTelegramForbiddenError(hay)) {
      forbidden += 1
    }
    if (isTelegramUnauthorizedError(hay)) {
      unauthorized += 1
    }
    if (hay.includes('flood_wait') || hay.includes('retry after')) {
      flood_wait += 1
    }
  }

  return { invalid_message_id, send_as_peer_invalid, forbidden, unauthorized, flood_wait, no_thread_mapping }
}

function buildChainIssues(input: {
  chain: TgChainRecord
  tokenPresent: boolean
  botId: number | null
  discussionChatId: number | null
  botChannelAdmin: boolean | null
  botDiscussionMember: boolean | null
  mappingStats: ReturnType<typeof countPostMappingThreadStats>
  mappingChannelMismatch: number
  pendingMaxToTg: number
}): CommentSyncIssue[] {
  const issues: CommentSyncIssue[] = []
  const {
    chain,
    tokenPresent,
    botId,
    discussionChatId,
    botChannelAdmin,
    botDiscussionMember,
    mappingStats,
    mappingChannelMismatch,
    pendingMaxToTg,
  } = input

  if (tokenPresent && botId == null) {
    issues.push({
      severity: 'critical',
      code: 'telegram_token_invalid',
      title: 'Токен Telegram недействителен (401)',
      description: 'getMe не проходит — бот не авторизован в Telegram API.',
      what_to_do:
        'Обновите токен в Админка → Интеграции или TG_TOKEN в .env, проверьте бота в @BotFather и перезапустите сервис.',
    })
    return issues
  }

  if (chain.forward_comments !== true) {
    issues.push({
      severity: 'info',
      code: 'forward_comments_disabled',
      title: 'Синхронизация комментариев выключена',
      description: 'Цепочка не слушает группу обсуждений.',
      what_to_do: 'Включите forward_comments в настройках цепочки TG→MAX.',
    })
    return issues
  }

  if (discussionChatId == null) {
    issues.push({
      severity: 'critical',
      code: 'no_discussion_group',
      title: 'Не привязана группа обсуждений',
      description: 'Telegram-канал не имеет linked discussion group или бот не может её прочитать.',
      what_to_do:
        'В настройках канала Telegram включите «Обсуждение» и укажите tg_discussion_chat_id в цепочке.',
    })
  }

  if (botChannelAdmin === false) {
    issues.push({
      severity: 'critical',
      code: 'bot_not_channel_admin',
      title: 'Бот не администратор канала',
      description: 'Без прав администратора бот не может работать с комментариями канала.',
      what_to_do: 'Добавьте бота администратором TG-канала и обновите токен при необходимости.',
    })
  }

  if (discussionChatId != null && botDiscussionMember === false) {
    issues.push({
      severity: 'critical',
      code: 'bot_not_in_discussion',
      title: 'Бот не в группе обсуждений',
      description: 'Бот не получает авто-репосты постов и комментарии из discussion group.',
      what_to_do: 'Добавьте бота в группу обсуждений с правом читать сообщения.',
    })
  }

  if (!isMtprotoSessionReady()) {
    issues.push({
      severity: 'warning',
      code: 'mtproto_not_configured',
      title: 'MTProto-сессия не настроена',
      description:
        'Без user-сессии нельзя восстановить thread mapping и отправлять от имени канала.',
      what_to_do: 'Настройте TG_API_ID, TG_API_HASH и TG_USER_SESSION в mtproto-config.',
    })
  }

  if (chain.tg_discussion_send_as !== 'chat' && !isMtprotoSessionReady()) {
    issues.push({
      severity: 'warning',
      code: 'send_as_channel_unavailable',
      title: 'Отправка от имени канала недоступна',
      description: 'SEND_AS_PEER_INVALID возможен без MTProto и прав на send-as.',
      what_to_do: 'Переключите tg_discussion_send_as на chat или настройте MTProto user-сессию.',
    })
  }

  if (mappingChannelMismatch > 0) {
    issues.push({
      severity: 'warning',
      code: 'mapping_channel_mismatch',
      title: 'Маппинги привязаны к другому TG-каналу',
      description: `${mappingChannelMismatch} записей post_comment_mapping имеют tg_chat_id, не совпадающий с настройками цепочки.`,
      what_to_do:
        'Проверьте tg_channel_id / tg_username в цепочке или пересоздайте связку. После деплоя repair-threads использует tg_chat_id из маппинга.',
    })
  }

  if (mappingStats.missing_thread > 0) {
    issues.push({
      severity: mappingStats.missing_thread > mappingStats.with_thread ? 'critical' : 'warning',
      code: 'missing_thread_mappings',
      title: 'Посты без привязки к тредам',
      description: `${mappingStats.missing_thread} из ${mappingStats.total} постов не имеют tg_thread_msg_id.`,
      what_to_do: 'Запустите POST /admin/comment-sync/repair-threads для восстановления через GetDiscussionMessage.',
    })
  }

  if (pendingMaxToTg > 0) {
    issues.push({
      severity: 'warning',
      code: 'pending_max_to_tg',
      title: 'Комментарии MAX ждут отправки в TG',
      description: `${pendingMaxToTg} комментариев из miniapp ещё не синхронизированы в Telegram.`,
      what_to_do: 'Исправьте thread mapping и права бота. Синхронизация идёт пакетами (TELEGRAM_COMMENT_SYNC_BATCH_SIZE) с интервалом MAX_COMMENT_SYNC_INTERVAL_MS.',
    })
  }

  return issues
}

export async function diagnoseCommentSync(chainIdFilter?: string): Promise<CommentSyncDiagnosticsReport> {
  const chains = listTgChainsSync().filter((c) => !chainIdFilter || c.id === chainIdFilter)
  const mtprotoReady = isMtprotoSessionReady()
  const mtprotoSource = resolveMtprotoCredentials().source
  const resultChains: CommentSyncChainDiagnostics[] = []

  for (const chain of chains) {
    const token = resolveBotTokenForChain(chain)
    const botId = token ? await getBotUserId(token) : null
    const channelChatId = resolveChannelChatId(chain)
    const discussionChatId = token ? await resolveDiscussionChatId(token, chain) : null

    let botChannelAdmin: boolean | null = null
    if (token && botId != null && channelChatId) {
      botChannelAdmin = await isBotChatAdmin(token, channelChatId, botId)
    }

    let botDiscussionMember: boolean | null = null
    if (token && botId != null && discussionChatId != null) {
      botDiscussionMember = await isBotChatMember(token, discussionChatId, botId)
    }

    const mappingStats = countPostMappingThreadStats(chain.id)
    const mappingChannelMismatch = countMappingChannelIdMismatch(chain.id)
    const pendingMaxToTg = countPendingMaxToTelegram(chain.max_chat_id)
    const issues = buildChainIssues({
      chain,
      tokenPresent: Boolean(token),
      botId,
      discussionChatId,
      botChannelAdmin,
      botDiscussionMember,
      mappingStats,
      mappingChannelMismatch,
      pendingMaxToTg,
    })

    resultChains.push({
      chain_id: chain.id,
      chain_name: chain.tg_username?.trim() || chain.tg_channel_id?.trim() || chain.id,
      active: chain.active !== false,
      forward_comments: chain.forward_comments === true,
      discussion_chat_id: discussionChatId,
      discussion_linked: discussionChatId != null,
      bot_channel_admin: botChannelAdmin,
      bot_discussion_member: botDiscussionMember,
      mtproto_ready: mtprotoReady,
      send_as_mode: chain.tg_discussion_send_as === 'chat' ? 'chat' : 'channel',
      mapping_stats: mappingStats,
      pending_max_to_tg: pendingMaxToTg,
      issues,
    })
  }

  const logEntries = getAdminLogTail(1000)
    .map(parseAdminLogLine)
    .filter((e): e is AdminLogEntry => e !== null)
  const logSignals = analyzeLogSignals(logEntries)

  const recommendations: string[] = []
  if (logSignals.invalid_message_id > 0) {
    recommendations.push(
      'Обнаружены MSG_ID_INVALID: проверьте linked discussion group и запустите repair-threads.',
    )
  }
  if (logSignals.send_as_peer_invalid > 0) {
    recommendations.push(
      'Обнаружены SEND_AS_PEER_INVALID: проверьте права send-as или переключите tg_discussion_send_as на chat.',
    )
  }
  if (logSignals.unauthorized > 0) {
    recommendations.push(
      'Обнаружены ошибки 401/unauthorized: обновите токен Telegram в интеграциях и перезапустите сервис.',
    )
  }
  if (logSignals.forbidden > 0) {
    recommendations.push('Обнаружены ошибки 403/forbidden: проверьте токен бота и права в канале/группе.')
  }
  if (logSignals.flood_wait > 0) {
    recommendations.push(
      'Обнаружен FLOOD_WAIT: увеличьте TELEGRAM_API_MIN_INTERVAL_MS (рекомендуется 2000–3000) и уменьшите TELEGRAM_COMMENT_SYNC_BATCH_SIZE.',
    )
  }
  if (!mtprotoReady) {
    recommendations.push(`MTProto не настроен (source: ${mtprotoSource}) — thread recovery ограничен.`)
  }
  if (recommendations.length === 0) {
    recommendations.push('Критичных сигналов в логах за 24ч не найдено. При проблемах запустите repair-threads.')
  }

  return {
    checked_at: new Date().toISOString(),
    chains: resultChains,
    log_signals_24h: logSignals,
    recommendations,
  }
}

export interface RepairThreadMappingsResult {
  chain_id: string
  attempted: number
  repaired: number
  failed: number
  samples: Array<{ max_mid: string; tg_msg_id: number; ok: boolean }>
}

export async function repairMissingThreadMappings(
  chainId: string,
  limit = 30,
): Promise<RepairThreadMappingsResult> {
  const mappings = listMappingsMissingThread(chainId, limit)
  let repaired = 0
  let failed = 0
  const samples: RepairThreadMappingsResult['samples'] = []

  for (let i = 0; i < mappings.length; i += 1) {
    const mapping = mappings[i]!
    const maxMid = mapping.max_mid?.trim()
    if (!maxMid) {
      failed += 1
      continue
    }
    try {
      const result = await ensurePostThreadMapping(maxMid)
      const ok = Boolean(result?.tg_thread_chat_id && result?.tg_thread_msg_id)
      if (ok) {
        repaired += 1
      } else {
        failed += 1
      }
      if (samples.length < 10) {
        samples.push({
          max_mid: maxMid,
          tg_msg_id: mapping.tg_msg_id,
          ok,
        })
      }
    } catch (err: unknown) {
      failed += 1
      logger.warn('[commentSyncDiagnostics] repair thread mapping failed', {
        chainId,
        maxMid,
        tgMsgId: mapping.tg_msg_id,
        err,
      })
    }
    if (i < mappings.length - 1) {
      await sleep(getTelegramApiMinIntervalMs())
    }
  }

  logger.info('[commentSyncDiagnostics] repair thread mappings finished', {
    chainId,
    attempted: mappings.length,
    repaired,
    failed,
  })

  return {
    chain_id: chainId,
    attempted: mappings.length,
    repaired,
    failed,
    samples,
  }
}

export interface BootstrapCommentSyncResult {
  mappings_backfilled: number
  chains_repaired: number
  threads_repaired: number
  threads_failed: number
  pending_without_mapping: number
}

/** На старте: backfill post_comment_mapping и починка тредов для активных цепочек. */
export async function bootstrapCommentSyncOnStartup(options?: {
  threadRepairLimit?: number
  repairThreads?: boolean
}): Promise<BootstrapCommentSyncResult> {
  const threadRepairLimit = options?.threadRepairLimit ?? 5
  const repairThreads = options?.repairThreads !== false
  const mappingsBackfilled = backfillPostCommentMappingsFromForwarded()
  let chainsRepaired = 0
  let threadsRepaired = 0
  let threadsFailed = 0

  if (repairThreads) {
    const chains = listTgChainsSync().filter((c) => c.active !== false && c.forward_comments === true)
    for (const chain of chains) {
      const repair = await repairMissingThreadMappings(chain.id, threadRepairLimit)
      if (repair.attempted > 0) {
        chainsRepaired += 1
        threadsRepaired += repair.repaired
        threadsFailed += repair.failed
      }
    }
  }

  const pendingRow = getDb()
    .prepare(
      `SELECT COUNT(*) AS n
       FROM comments c
       JOIN posts p ON p.post_id = c.post_id
       LEFT JOIN post_comment_mapping m ON m.max_mid = p.message_mid
       WHERE (c.source IS NULL OR c.source = 'max')
         AND (c.tg_comment_id IS NULL OR c.tg_comment_id = 0)
         AND m.id IS NULL`,
    )
    .get() as { n: number }
  const pendingWithoutMapping = Number(pendingRow.n) || 0

  const result: BootstrapCommentSyncResult = {
    mappings_backfilled: mappingsBackfilled,
    chains_repaired: chainsRepaired,
    threads_repaired: threadsRepaired,
    threads_failed: threadsFailed,
    pending_without_mapping: pendingWithoutMapping,
  }

  logger.info('[commentSync] bootstrap on startup', result)
  if (pendingWithoutMapping > 0) {
    logger.warn(
      '[commentSync] комментарии без TG-маппинга не переносятся в Telegram — нужны посты из TG (forward_posts) или repair-threads',
      { pending_without_mapping: pendingWithoutMapping },
    )
  }

  return result
}
