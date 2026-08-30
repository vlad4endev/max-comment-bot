/**
 * Маркировка TG-постов при кросс-платформенной брони комментариев.
 */

import { telegramAxios as axios } from '../utils/telegramAxios'

import { listTgChainsSync } from '../api/adminPanelState'
import { appendBookingMarker } from '../utils/commentSyncFilter'
import { logger } from '../utils/logger'
import { findMappingByMaxMid, type PostCommentMappingRow } from './postCommentMappingStore'
import type { Post } from './postStore'
import { postStore } from './postStore'
import { ensurePostThreadMapping } from './telegramDiscussionThreadResolver'
import { resolveTelegramBotToken } from './resolveTelegramBotToken'

const TG_API = 'https://api.telegram.org'

type TgMessageTarget = {
  token: string
  chatId: number
  messageId: number
  messageThreadId?: number
}

type ThreadTarget = {
  token: string
  threadChatId: number
  threadMsgId: number
}

function resolveTelegramBotTokenForChain(chainId: string): string {
  const chain = listTgChainsSync().find((c) => c.id === chainId)
  const fromChain = chain?.bot_token?.trim()
  if (fromChain) return fromChain
  return resolveTelegramBotToken()
}

function isCommentForwardEnabled(chainId: string): boolean {
  const chain = listTgChainsSync().find((c) => c.id === chainId)
  return chain?.active !== false && chain?.forward_comments === true
}

function resolvePostThreadTargetFromMapping(mapping: PostCommentMappingRow): ThreadTarget | null {
  if (!mapping.tg_thread_chat_id || !mapping.tg_thread_msg_id) return null
  if (!isCommentForwardEnabled(mapping.chain_id)) return null
  const token = resolveTelegramBotTokenForChain(mapping.chain_id)
  if (!token) return null
  return {
    token,
    threadChatId: mapping.tg_thread_chat_id,
    threadMsgId: mapping.tg_thread_msg_id,
  }
}

async function resolvePostThreadTarget(messageMid: string): Promise<ThreadTarget | null> {
  await ensurePostThreadMapping(messageMid)
  const mapping = findMappingByMaxMid(messageMid)
  if (!mapping) return null
  return resolvePostThreadTargetFromMapping(mapping)
}

function tgPayload(target: TgMessageTarget, body: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    chat_id: target.chatId,
    message_id: target.messageId,
    ...body,
  }
  if (typeof target.messageThreadId === 'number' && target.messageThreadId > 0) {
    payload.message_thread_id = target.messageThreadId
  }
  return payload
}

async function tryEditTelegramPostBody(target: TgMessageTarget, markedText: string): Promise<boolean> {
  for (const method of ['editMessageCaption', 'editMessageText'] as const) {
    const bodyKey = method === 'editMessageCaption' ? 'caption' : 'text'
    try {
      const { data } = await axios.post<{ ok: boolean }>(
        `${TG_API}/bot${target.token}/${method}`,
        tgPayload(target, { [bodyKey]: markedText }),
        { timeout: 15_000 },
      )
      if (data.ok) return true
    } catch {
      // try next method
    }
  }
  return false
}

/** Дописывает маркер брони к TG-посту (канал + тред обсуждения). */
export async function applyTelegramPostBookingMarker(post: Post, marker: string): Promise<boolean> {
  const freshPost = postStore.getPost(post.post_id) ?? post
  const baseText = freshPost.text?.trim() || ''
  if (!baseText) {
    logger.warn('[telegramPostMarker] empty post text for booked marker', {
      postId: freshPost.post_id,
    })
    return false
  }
  if (baseText.includes(marker)) {
    if (marker.includes('МАКС')) {
      postStore.markTgBookedInMaxApplied(freshPost.post_id)
    }
    return true
  }

  const markedText = appendBookingMarker(baseText, marker)
  const target = await resolvePostThreadTarget(freshPost.message_mid)
  if (!target) {
    logger.warn('[telegramPostMarker] no thread target for booking marker', {
      postId: freshPost.post_id,
      messageMid: freshPost.message_mid,
    })
    return false
  }

  const mapping = findMappingByMaxMid(freshPost.message_mid)
  const editTargets: TgMessageTarget[] = []
  if (typeof mapping?.tg_chat_id === 'number' && mapping.tg_msg_id > 0) {
    editTargets.push({
      token: target.token,
      chatId: mapping.tg_chat_id,
      messageId: mapping.tg_msg_id,
    })
  }
  editTargets.push({
    token: target.token,
    chatId: target.threadChatId,
    messageId: target.threadMsgId,
    messageThreadId: target.threadMsgId,
  })

  for (const editTarget of editTargets) {
    if (await tryEditTelegramPostBody(editTarget, markedText)) {
      if (marker.includes('МАКС')) {
        postStore.markTgBookedInMaxApplied(freshPost.post_id)
      }
      logger.info('[telegramPostMarker] appended booking marker to TG post', {
        postId: freshPost.post_id,
        chatId: editTarget.chatId,
        messageId: editTarget.messageId,
        marker,
      })
      return true
    }
  }

  logger.warn('[telegramPostMarker] failed to append booking marker', {
    postId: freshPost.post_id,
    marker,
  })
  return false
}
