import axios from 'axios'
import { Api } from 'telegram'
import { Raw } from 'telegram/events'
import type { Bot } from '@maxhub/max-bot-api'
import type Database from 'better-sqlite3'

import { listTgChainsSync } from '../api/adminPanelState'
import { getDb } from '../db/database'
import { logger } from '../utils/logger'
import { apiCallWithRetry } from '../utils/maxApiRetry'
import { getPersistentMtprotoClient } from './telegramUserArchive'
import { isMtprotoSessionReady } from './mtprotoConfigStore'

const recentlyDeletedPosts = new Set<string>()

let watcherStarted = false
let botRef: Bot | null = null

export function getDeletionWatcherStatus(): { active: boolean; mtproto_ready: boolean } {
  return {
    active: watcherStarted,
    mtproto_ready: isMtprotoSessionReady(),
  }
}

export function startTgPostDeletionWatcher(bot: Bot): void {
  botRef = bot

  if (!isMtprotoSessionReady()) {
    logger.info('[tgDeletionWatcher] MTProto not configured, skipping')
    return
  }

  if (watcherStarted) {
    return
  }
  watcherStarted = true

  setTimeout(() => {
    initWatcher().catch((err: unknown) => {
      logger.warn('[tgDeletionWatcher] init failed', { err })
    })
  }, 30_000)
}

async function initWatcher(): Promise<void> {
  const client = await getPersistentMtprotoClient()
  if (!client) {
    logger.warn('[tgDeletionWatcher] no MTProto client, will retry in 5 min')
    setTimeout(
      () => {
        initWatcher().catch(() => {})
      },
      5 * 60_000,
    )
    return
  }

  client.addEventHandler(
    async (update: Api.TypeUpdate) => {
      try {
        await handleTelegramUpdate(update)
      } catch (err: unknown) {
        logger.warn('[tgDeletionWatcher] update handler error', { err })
      }
    },
    new Raw({ types: [Api.UpdateDeleteChannelMessages] }),
  )

  logger.info('[tgDeletionWatcher] listening for channel post deletions')
}

function normalizeMtprotoChannelId(channelId: Api.UpdateDeleteChannelMessages['channelId']): string | null {
  if (channelId === undefined || channelId === null) {
    return null
  }
  const raw =
    typeof channelId === 'object' && channelId !== null && 'toString' in channelId
      ? channelId.toString()
      : String(channelId)
  const numeric = Number(raw)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null
  }
  return `-100${numeric}`
}

function normalizeDeletedMessageIds(
  messages: Api.UpdateDeleteChannelMessages['messages'],
): number[] {
  if (!messages?.length) {
    return []
  }
  const out: number[] = []
  for (const id of messages) {
    const numeric = Number(id)
    if (Number.isFinite(numeric) && numeric > 0) {
      out.push(numeric)
    }
  }
  return out
}

async function handleTelegramUpdate(update: Api.TypeUpdate): Promise<void> {
  if (!(update instanceof Api.UpdateDeleteChannelMessages)) {
    return
  }

  const tgChannelId = normalizeMtprotoChannelId(update.channelId)
  const deletedMsgIds = normalizeDeletedMessageIds(update.messages)

  if (!tgChannelId || deletedMsgIds.length === 0) {
    return
  }

  const channelIdBare = tgChannelId.replace(/^-100/, '')

  const chains = listTgChainsSync().filter(
    (c) =>
      c.active &&
      c.forward_posts &&
      (c.tg_channel_id === tgChannelId || c.tg_channel_id === channelIdBare),
  )

  if (chains.length === 0) {
    return
  }

  logger.info('[tgDeletionWatcher] channel post deleted in TG', {
    tgChannelId,
    deletedMsgIds,
    matchedChains: chains.length,
  })

  const db = getDb()

  for (const msgId of deletedMsgIds) {
    for (const chain of chains) {
      try {
        await handleDeletedPost(db, chain.id, tgChannelId, msgId)
      } catch (err: unknown) {
        logger.warn('[tgDeletionWatcher] failed to handle deletion', {
          tgChannelId,
          msgId,
          chainId: chain.id,
          err,
        })
      }
    }
  }
}

export async function handleDeletedPost(
  db: Database.Database,
  chainId: string,
  _tgChannelId: string,
  tgMsgId: number,
): Promise<void> {
  const dedupeKey = `${chainId}:${tgMsgId}`
  if (recentlyDeletedPosts.has(dedupeKey)) {
    return
  }
  recentlyDeletedPosts.add(dedupeKey)
  setTimeout(() => recentlyDeletedPosts.delete(dedupeKey), 30_000)

  const mapping = db
    .prepare(
      `SELECT m.max_mid, p.post_id, p.chat_id, p.message_mid AS max_msg_id
       FROM post_comment_mapping m
       JOIN posts p ON p.message_mid = m.max_mid
       WHERE m.chain_id = ?
         AND m.tg_msg_id = ?
       LIMIT 1`,
    )
    .get(chainId, tgMsgId) as
    | {
        max_mid: string
        post_id: string
        chat_id: number
        max_msg_id: string | null
      }
    | undefined

  if (!mapping) {
    const post = db
      .prepare(
        `SELECT post_id, chat_id, message_mid AS max_msg_id,
                json_extract(data, '$.tg_msg_id') AS stored_tg_msg_id
         FROM posts
         WHERE json_extract(data, '$.tg_msg_id') = ?
         LIMIT 1`,
      )
      .get(tgMsgId) as
      | {
          post_id: string
          chat_id: number
          max_msg_id: string | null
          stored_tg_msg_id: number | null
        }
      | undefined

    if (!post) {
      logger.debug('[tgDeletionWatcher] no post found for deleted TG msg', {
        tgMsgId,
        chainId,
      })
      return
    }

    await deleteMaxPost(post.post_id, post.chat_id, post.max_msg_id, tgMsgId, chainId)
    return
  }

  await deleteMaxPost(mapping.post_id, mapping.chat_id, mapping.max_msg_id, tgMsgId, chainId)
}

async function deleteMaxPost(
  postId: string,
  chatId: number,
  maxMsgId: string | null,
  tgMsgId: number,
  chainId: string,
): Promise<void> {
  const db = getDb()
  const mid = maxMsgId?.trim() ?? ''

  if (mid !== '' && botRef) {
    try {
      await apiCallWithRetry(() => botRef!.api.deleteMessage(mid))
      logger.info('[tgDeletionWatcher] deleted MAX post', {
        postId,
        chatId,
        maxMsgId: mid,
        tgMsgId,
      })
    } catch (err: unknown) {
      const axiosCode =
        axios.isAxiosError(err) &&
        err.response?.data &&
        typeof err.response.data === 'object' &&
        'code' in err.response.data
          ? String((err.response.data as { code?: string }).code ?? '')
          : ''
      const status = axios.isAxiosError(err) ? err.response?.status : undefined
      if (axiosCode !== 'message.not_found' && status !== 404) {
        logger.warn('[tgDeletionWatcher] MAX delete failed', {
          postId,
          maxMsgId: mid,
          err: String(err),
        })
      }
    }
  }

  db.prepare(
    `DELETE FROM post_comment_mapping
     WHERE max_mid = (SELECT message_mid FROM posts WHERE post_id = ?)`,
  ).run(postId)

  db.prepare(
    `UPDATE comments
     SET tg_comment_id = -999
     WHERE post_id = ?
       AND (tg_comment_id IS NULL OR tg_comment_id = 0 OR tg_comment_id > 0)`,
  ).run(postId)

  db.prepare('DELETE FROM posts WHERE post_id = ?').run(postId)

  logger.info('[tgDeletionWatcher] post cleanup complete', {
    postId,
    chatId,
    tgMsgId,
    chainId,
  })
}
