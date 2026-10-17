/**
 * Строгая привязка комментариев к связке (tg_chain).
 *
 * Комментарий MAX→TG должен уйти только туда, куда ведёт связка этого MAX-канала:
 *  - строка post_comment_mapping принадлежит существующей связке, чей max_chat_id — канал поста;
 *  - тред лежит в группе обсуждения, заданной в связке (tg_discussion_chat_id), если она задана.
 * Если однозначно определить нельзя — не отправляем (лучше задержка и алерт, чем чужой чат).
 */

import type { TgChainRecord } from '../api/adminPanelState'
import { sendAdminAlert } from '../utils/alertService'
import { logger } from '../utils/logger'
import { TtlCache } from '../utils/ttlCache'
import type { PostCommentMappingRow } from './postCommentMappingStore'

/** id каналов MAX встречаются как со знаком, так и без — сравниваем по модулю. */
export function sameMaxChat(
  a: number | string | null | undefined,
  b: number | string | null | undefined,
): boolean {
  const x = Number(a)
  const y = Number(b)
  return Number.isFinite(x) && Number.isFinite(y) && x !== 0 && Math.abs(x) === Math.abs(y)
}

export type MappingRejectReason = 'no_live_chain' | 'max_chat_mismatch'

export interface PickedMapping {
  mapping: PostCommentMappingRow | null
  /** Почему подходящих строк не осталось (когда rows не пуст, а mapping = null). */
  rejected: Array<{ chainId: string; reason: MappingRejectReason }>
}

/**
 * Из строк маппинга одного поста оставляет только принадлежащие живой связке этого MAX-канала.
 * Порядок предпочтения сохраняется как в rows (сначала строки с рабочим тредом, затем новые).
 * `chains` пуст = конфиг ещё не загружен: не режем ничего (поведение как раньше).
 */
export function pickLinkedMapping(
  rows: PostCommentMappingRow[],
  chains: TgChainRecord[],
  postChatId: number | null,
): PickedMapping {
  if (chains.length === 0) {
    return { mapping: rows[0] ?? null, rejected: [] }
  }
  const byId = new Map(chains.map((c) => [c.id, c]))
  const rejected: PickedMapping['rejected'] = []
  for (const row of rows) {
    const chain = byId.get(row.chain_id)
    if (!chain) {
      rejected.push({ chainId: row.chain_id, reason: 'no_live_chain' })
      continue
    }
    if (postChatId != null && !sameMaxChat(chain.max_chat_id, postChatId)) {
      rejected.push({ chainId: row.chain_id, reason: 'max_chat_mismatch' })
      continue
    }
    return { mapping: row, rejected }
  }
  return { mapping: null, rejected }
}

/** Группа обсуждения из настроек связки (только явно заданная) или null. */
export function configuredDiscussionChatId(chain: TgChainRecord): number | null {
  const raw = chain.tg_discussion_chat_id?.trim()
  return raw && /^-?\d+$/.test(raw) ? Number(raw) : null
}

/** Тред лежит не в той группе, что задана в связке → {expected, actual}; иначе null. */
export function threadChatMismatch(
  mapping: Pick<PostCommentMappingRow, 'tg_thread_chat_id'>,
  chain: TgChainRecord,
): { expected: number; actual: number } | null {
  const expected = configuredDiscussionChatId(chain)
  const actual = mapping.tg_thread_chat_id
  if (expected == null || typeof actual !== 'number' || actual === 0) {
    return null
  }
  return expected === actual ? null : { expected, actual }
}

const reportedOnce = new TtlCache<string, true>()
const REPORT_TTL_MS = 60 * 60_000

export function warnOnce(key: string, message: string, extra: Record<string, unknown>): void {
  if (reportedOnce.has(key)) {
    return
  }
  reportedOnce.set(key, true, REPORT_TTL_MS)
  logger.warn(message, extra)
}

/** Тред поста не в группе обсуждения связки: отправка заблокирована, админу — алерт (с кулдауном). */
export function reportThreadChatMismatch(
  chain: TgChainRecord,
  mapping: PostCommentMappingRow,
  mismatch: { expected: number; actual: number },
): void {
  warnOnce(
    `thread-mismatch:${chain.id}:${mismatch.actual}`,
    '[commentLink] thread is outside the chain discussion chat — MAX→TG send blocked',
    {
      chainId: chain.id,
      title: chain.max_title ?? null,
      maxMid: mapping.max_mid,
      configuredDiscussion: mismatch.expected,
      threadChat: mismatch.actual,
    },
  )
  void sendAdminAlert(
    `link_thread_mismatch:${chain.id}`,
    `Связка «${chain.max_title ?? chain.id}»: тред поста в группе ${mismatch.actual}, а в связке задана ${mismatch.expected}. Комментарии из MAX не отправляются, чтобы не попасть в чужой чат.`,
    {
      chainId: chain.id,
      configuredDiscussion: mismatch.expected,
      threadChat: mismatch.actual,
      hint: 'Проверьте группу обсуждения канала в Telegram и поле tg_discussion_chat_id в связке',
    },
  )
}
