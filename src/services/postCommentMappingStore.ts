import axios from 'axios'

import type { TgChainRecord } from '../api/adminPanelState'
import { getDb } from '../db/database'
import { logger } from '../utils/logger'

const TG_API = 'https://api.telegram.org'

export interface PostCommentMappingRow {
  chain_id: string
  tg_msg_id: number
  max_mid: string
  tg_chat_id: number | null
  tg_thread_chat_id: number | null
  tg_thread_msg_id: number | null
}

const discussionChatCache = new Map<string, number | null>()

export function upsertPostCommentMapping(
  chainId: string,
  tgMsgId: number,
  maxMid: string,
  tgChatId: number | null,
): void {
  getDb()
    .prepare(
      `INSERT INTO post_comment_mapping (chain_id, tg_msg_id, max_mid, tg_chat_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chain_id, tg_msg_id) DO UPDATE SET
         max_mid    = excluded.max_mid,
         tg_chat_id = excluded.tg_chat_id`,
    )
    .run(chainId, tgMsgId, maxMid, tgChatId)
}

export function linkThreadMessageToChannelPost(
  chainId: string,
  channelMsgId: number,
  threadChatId: number,
  threadMsgId: number,
): void {
  getDb()
    .prepare(
      `UPDATE post_comment_mapping
       SET tg_thread_chat_id = ?, tg_thread_msg_id = ?
       WHERE chain_id = ? AND tg_msg_id = ?`,
    )
    .run(threadChatId, threadMsgId, chainId, channelMsgId)
}

export function findMappingByThreadMsgId(
  chainId: string,
  threadMsgId: number,
): PostCommentMappingRow | null {
  const row = getDb()
    .prepare(
      `SELECT chain_id, tg_msg_id, max_mid, tg_chat_id, tg_thread_chat_id, tg_thread_msg_id
       FROM post_comment_mapping
       WHERE chain_id = ? AND tg_thread_msg_id = ?`,
    )
    .get(chainId, threadMsgId) as PostCommentMappingRow | undefined
  return row ?? null
}

export function findMappingByMaxMid(maxMid: string): PostCommentMappingRow | null {
  const row = getDb()
    .prepare(
      `SELECT chain_id, tg_msg_id, max_mid, tg_chat_id, tg_thread_chat_id, tg_thread_msg_id
       FROM post_comment_mapping
       WHERE max_mid = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(maxMid.trim()) as PostCommentMappingRow | undefined
  return row ?? null
}

export async function resolveDiscussionChatId(
  tgToken: string,
  chain: TgChainRecord,
): Promise<number | null> {
  const cacheKey = `${chain.id}:${tgToken}`
  if (discussionChatCache.has(cacheKey)) {
    return discussionChatCache.get(cacheKey) ?? null
  }

  const channelKey = chain.tg_channel_id?.trim() || chain.tg_username?.trim().replace(/^@/, '')
  if (!channelKey) {
    discussionChatCache.set(cacheKey, null)
    return null
  }

  const chatId = /^-?\d+$/.test(channelKey)
    ? channelKey
    : `@${channelKey.replace(/^@/, '')}`

  try {
    const { data } = await axios.get<{
      ok: boolean
      result?: { linked_chat_id?: number }
    }>(`${TG_API}/bot${tgToken}/getChat`, {
      params: { chat_id: chatId },
      timeout: 15_000,
    })
    const linked =
      data.ok && typeof data.result?.linked_chat_id === 'number'
        ? data.result.linked_chat_id
        : null
    discussionChatCache.set(cacheKey, linked)
    return linked
  } catch (err: unknown) {
    logger.warn('postCommentMapping: getChat linked_chat_id failed', { chainId: chain.id, err })
    discussionChatCache.set(cacheKey, null)
    return null
  }
}

export async function storeDiscussionChatIdForChain(
  tgToken: string,
  chain: TgChainRecord,
): Promise<void> {
  const threadChatId = await resolveDiscussionChatId(tgToken, chain)
  if (threadChatId == null) {
    return
  }
  getDb()
    .prepare(
      `UPDATE post_comment_mapping
       SET tg_thread_chat_id = ?
       WHERE chain_id = ? AND (tg_thread_chat_id IS NULL OR tg_thread_chat_id = 0)`,
    )
    .run(threadChatId, chain.id)
}
