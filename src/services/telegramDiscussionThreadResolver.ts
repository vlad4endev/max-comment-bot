/**
 * Восстанавливает tg_thread_chat_id / tg_thread_msg_id для post_comment_mapping,
 * если авто-репост канала в группу обсуждений был пропущен (бот не был в группе и т.п.).
 */

import { Api } from 'telegram'

import type { TgChainRecord } from '../api/adminPanelState'
import { listTgChainsSync } from '../api/adminPanelState'
import { logger } from '../utils/logger'
import {
  findMappingByMaxMid,
  linkThreadMessageToChannelPost,
  resolveDiscussionChatId,
  type PostCommentMappingRow,
} from './postCommentMappingStore'
import { resolveTelegramBotToken } from './resolveTelegramBotToken'
import { isMtprotoSessionReady, resolveMtprotoCredentials } from './mtprotoConfigStore'
import {
  connectTelegramUserClient,
  resolveTelegramChannelEntity,
} from './telegramUserArchive'

function resolveBotTokenForChain(chain: TgChainRecord): string {
  const fromChain = chain.bot_token?.trim()
  if (fromChain) {
    return fromChain
  }
  return resolveTelegramBotToken()
}

function resolveChannelKey(chain: TgChainRecord, mapping: PostCommentMappingRow): string | null {
  const fromChainId = chain.tg_channel_id?.trim()
  if (fromChainId) {
    return fromChainId
  }
  const username = chain.tg_username?.trim()
  if (username) {
    return username.startsWith('@') ? username : `@${username}`
  }
  if (typeof mapping.tg_chat_id === 'number') {
    return String(mapping.tg_chat_id)
  }
  return null
}

function peerIdToBotChatId(peerId: Api.TypePeer | undefined): number | null {
  if (peerId instanceof Api.PeerChannel) {
    return Number(`-100${peerId.channelId}`)
  }
  if (peerId instanceof Api.PeerChat) {
    return -peerId.chatId
  }
  return null
}

function extractThreadFromDiscussionMessage(
  result: Api.messages.TypeDiscussionMessage,
): { threadChatId: number; threadMsgId: number } | null {
  if (!(result instanceof Api.messages.DiscussionMessage)) {
    return null
  }
  for (const raw of result.messages ?? []) {
    if (!(raw instanceof Api.Message)) {
      continue
    }
    const threadMsgId = raw.id
    if (typeof threadMsgId !== 'number' || threadMsgId <= 0) {
      continue
    }
    const threadChatId = peerIdToBotChatId(raw.peerId)
    if (threadChatId != null) {
      return { threadChatId, threadMsgId }
    }
  }
  return null
}

async function resolveThreadViaMtproto(
  chain: TgChainRecord,
  mapping: PostCommentMappingRow,
): Promise<{ threadChatId: number; threadMsgId: number } | null> {
  const mtproto = resolveMtprotoCredentials()
  if (!isMtprotoSessionReady()) {
    logger.debug('[discussionThreadResolver] MTProto session not configured', {
      chainId: chain.id,
      maxMid: mapping.max_mid,
      mtprotoSource: mtproto.source,
    })
    return null
  }
  if (typeof mapping.tg_msg_id !== 'number' || mapping.tg_msg_id <= 0) {
    return null
  }

  const channelKey = resolveChannelKey(chain, mapping)
  if (!channelKey) {
    return null
  }

  const client = await connectTelegramUserClient()
  try {
    const channelPeer = await resolveTelegramChannelEntity(client, channelKey)
    const result = await client.invoke(
      new Api.messages.GetDiscussionMessage({
        peer: channelPeer,
        msgId: mapping.tg_msg_id,
      }),
    )
    const extracted = extractThreadFromDiscussionMessage(result)
    if (extracted) {
      logger.info('[discussionThreadResolver] resolved thread via GetDiscussionMessage', {
        chainId: chain.id,
        channelMsgId: mapping.tg_msg_id,
        maxMid: mapping.max_mid,
        threadChatId: extracted.threadChatId,
        threadMsgId: extracted.threadMsgId,
      })
    }
    return extracted
  } catch (err: unknown) {
    logger.warn('[discussionThreadResolver] GetDiscussionMessage failed', {
      chainId: chain.id,
      channelMsgId: mapping.tg_msg_id,
      maxMid: mapping.max_mid,
      err,
    })
    return null
  } finally {
    await client.disconnect()
  }
}

/**
 * Дополняет post_comment_mapping полями треда обсуждения, если они ещё не заданы.
 * @returns mapping с заполненными thread id или null, если восстановить не удалось
 */
export async function ensurePostThreadMapping(maxMid: string): Promise<PostCommentMappingRow | null> {
  const normalized = maxMid.trim()
  if (!normalized) {
    return null
  }

  let mapping = findMappingByMaxMid(normalized)
  if (!mapping) {
    return null
  }
  if (mapping.tg_thread_chat_id && mapping.tg_thread_msg_id) {
    return mapping
  }

  const chain = listTgChainsSync().find((c) => c.id === mapping!.chain_id)
  if (!chain || chain.forward_comments !== true) {
    return null
  }

  const token = resolveBotTokenForChain(chain)
  let threadChatId = mapping.tg_thread_chat_id
  let threadMsgId = mapping.tg_thread_msg_id

  if (threadChatId == null) {
    threadChatId = await resolveDiscussionChatId(token, chain)
  }

  if (threadMsgId == null) {
    const resolved = await resolveThreadViaMtproto(chain, mapping)
    if (resolved) {
      threadChatId = resolved.threadChatId
      threadMsgId = resolved.threadMsgId
    }
  }

  if (
    threadChatId != null &&
    threadMsgId != null &&
    typeof mapping.tg_msg_id === 'number' &&
    mapping.tg_msg_id > 0
  ) {
    linkThreadMessageToChannelPost(mapping.chain_id, mapping.tg_msg_id, threadChatId, threadMsgId)
    mapping = findMappingByMaxMid(normalized)
    logger.info('[discussionThreadResolver] ensured post thread mapping', {
      maxMid: normalized,
      chainId: mapping?.chain_id ?? null,
      threadChatId,
      threadMsgId,
    })
    return mapping
  }

  logger.warn('[discussionThreadResolver] could not ensure thread mapping', {
    maxMid: normalized,
    chainId: mapping.chain_id,
    channelMsgId: mapping.tg_msg_id,
    threadChatId,
    threadMsgId,
    mtprotoReady: isMtprotoSessionReady(),
    mtprotoSource: resolveMtprotoCredentials().source,
  })
  return null
}
