/**
 * Маркировка TG-постов при кросс-платформенной брони комментариев.
 */

import { telegramAxios as axios } from '../utils/telegramAxios'

import { getDb } from '../db/database'
import type { TgMessage } from '../forwarder/telegramReader'

import { listTgChainsSync } from '../api/adminPanelState'
import { appendBookingMarker } from '../utils/commentSyncFilter'
import { logger } from '../utils/logger'
import { findMappingByMaxMid, hasUsableThread, type PostCommentMappingRow } from './postCommentMappingStore'
import type { Post } from './postStore'
import { postStore } from './postStore'
import { ensurePostThreadMapping } from './telegramDiscussionThreadResolver'
import { resolveTelegramBotToken } from './resolveTelegramBotToken'

const TG_API = 'https://api.telegram.org'

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
  if (!hasUsableThread(mapping)) return null
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

type OriginalChannelPost = {
  chatId: number
  messageId: number
  text: string
  entities: Array<Record<string, unknown>> | undefined
  isCaption: boolean
}

const TG_TEXT_LIMIT = 4096
const TG_CAPTION_LIMIT = 1024

/**
 * Оригинал поста канала из того, что мы сами получили из Telegram (текст + форматирование).
 * Текст поста из MAX (`post.text`) для правки TG использовать нельзя: он может быть
 * укорочен/переформатирован, и правка затрёт исходный пост.
 */
function loadOriginalChannelPost(mapping: PostCommentMappingRow): OriginalChannelPost | null {
  const row = getDb()
    .prepare('SELECT tg_payload FROM tg_chain_forwarded WHERE chain_id = ? AND tg_message_id = ?')
    .get(mapping.chain_id, mapping.tg_msg_id) as { tg_payload: string | null } | undefined
  if (!row?.tg_payload) return null
  let msg: TgMessage
  try {
    msg = JSON.parse(row.tg_payload) as TgMessage
  } catch {
    return null
  }
  const chatId = typeof mapping.tg_chat_id === 'number' ? mapping.tg_chat_id : msg.chat?.id
  if (typeof chatId !== 'number' || !(mapping.tg_msg_id > 0)) return null
  const hasText = typeof msg.text === 'string' && msg.text.trim() !== ''
  const hasCaption = typeof msg.caption === 'string' && msg.caption.trim() !== ''
  if (!hasText && !hasCaption) return null
  return {
    chatId,
    messageId: mapping.tg_msg_id,
    text: hasText ? msg.text! : msg.caption!,
    entities: hasText ? msg.entities : msg.caption_entities,
    isCaption: !hasText,
  }
}

async function editChannelPost(
  token: string,
  original: OriginalChannelPost,
  marker: string,
): Promise<boolean> {
  const limit = original.isCaption ? TG_CAPTION_LIMIT : TG_TEXT_LIMIT
  const markedText = appendBookingMarker(original.text, marker)
  if (markedText.length > limit) {
    logger.warn('[telegramPostMarker] marked text exceeds Telegram limit — post left untouched', {
      chatId: original.chatId,
      messageId: original.messageId,
    })
    return false
  }
  const method = original.isCaption ? 'editMessageCaption' : 'editMessageText'
  const body: Record<string, unknown> = {
    chat_id: original.chatId,
    message_id: original.messageId,
    [original.isCaption ? 'caption' : 'text']: markedText,
  }
  // Маркер дописывается в конец — смещения исходных entities остаются верными.
  if (original.entities?.length) {
    body[original.isCaption ? 'caption_entities' : 'entities'] = original.entities
  }
  try {
    const { data } = await axios.post<{ ok: boolean }>(`${TG_API}/bot${token}/${method}`, body, {
      timeout: 15_000,
    })
    return data.ok === true
  } catch (err: unknown) {
    logger.warn('[telegramPostMarker] edit channel post failed', { method, err })
    return false
  }
}

/** Дописывает маркер брони к посту в TG-канале, сохраняя исходный текст и форматирование. */
export async function applyTelegramPostBookingMarker(post: Post, marker: string): Promise<boolean> {
  const freshPost = postStore.getPost(post.post_id) ?? post
  const target = await resolvePostThreadTarget(freshPost.message_mid)
  const mapping = findMappingByMaxMid(freshPost.message_mid)
  if (!target || !mapping) {
    logger.warn('[telegramPostMarker] no thread target for booking marker', {
      postId: freshPost.post_id,
      messageMid: freshPost.message_mid,
    })
    return false
  }

  const original = loadOriginalChannelPost(mapping)
  if (!original) {
    // Нет исходного TG-текста — лучше не помечать, чем перезаписать пост чужим текстом.
    logger.warn('[telegramPostMarker] original TG post text unavailable — not editing', {
      postId: freshPost.post_id,
      chainId: mapping.chain_id,
      tgMsgId: mapping.tg_msg_id,
    })
    return false
  }

  const done = (): boolean => {
    if (marker.includes('МАКС')) {
      postStore.markTgBookedInMaxApplied(freshPost.post_id)
    }
    return true
  }
  if (original.text.includes(marker)) {
    return done()
  }
  if (await editChannelPost(target.token, original, marker)) {
    logger.info('[telegramPostMarker] appended booking marker to TG post', {
      postId: freshPost.post_id,
      chatId: original.chatId,
      messageId: original.messageId,
      marker,
    })
    return done()
  }
  logger.warn('[telegramPostMarker] failed to append booking marker', {
    postId: freshPost.post_id,
    marker,
  })
  return false
}
