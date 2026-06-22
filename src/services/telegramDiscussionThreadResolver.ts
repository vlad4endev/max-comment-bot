/**
 * Восстанавливает tg_thread_chat_id / tg_thread_msg_id для post_comment_mapping,
 * если авто-репост канала в группу обсуждений был пропущен (бот не был в группе и т.п.).
 */

import { Api } from 'telegram'
import { listTgChainsSync, type TgChainRecord } from '../api/adminPanelState'
import { logger } from '../utils/logger'
import { isInvalidTelegramMessageIdError } from '../utils/telegramSyncErrors'
import {
  findMappingByMaxMid,
  linkThreadMessageToChannelPost,
  clearPostThreadMapping,
  deletePostCommentMapping,
  backfillPostCommentMappingForMaxMid,
  resolveDiscussionChatId,
  listTelegramChannelKeyCandidatesForMapping,
  type PostCommentMappingRow,
} from './postCommentMappingStore'
import { resolveTelegramBotToken } from './resolveTelegramBotToken'
import { isMtprotoSessionReady, resolveMtprotoCredentials } from './mtprotoConfigStore'
import {
  connectTelegramUserClient,
  disconnectTelegramUserClient,
  resolveTelegramChannelEntity,
} from './telegramUserArchive'

function resolveBotTokenForChain(chain: TgChainRecord): string {
  const fromChain = chain.bot_token?.trim()
  if (fromChain) {
    return fromChain
  }
  return resolveTelegramBotToken()
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

  const token = resolveBotTokenForChain(chain)
  const discussionChatId = token ? await resolveDiscussionChatId(token, chain) : null
  const channelKeys = listTelegramChannelKeyCandidatesForMapping(mapping, chain, discussionChatId)
  if (channelKeys.length === 0) {
    return null
  }

  const tgChannelMsgId = mapping.tg_msg_id

  const client = await connectTelegramUserClient()
  try {
    let lastInvalidMsgId = false
    for (const channelKey of channelKeys) {
      try {
        const channelPeer = await resolveTelegramChannelEntity(client, channelKey)
        logger.debug('[discussionThreadResolver] resolving thread', {
          channelPeer: channelKey,
          tgMsgId: tgChannelMsgId,
          maxMid: mapping.max_mid,
        })
        const result = await client.invoke(
          new Api.messages.GetDiscussionMessage({
            peer: channelPeer,
            msgId: tgChannelMsgId,
          }),
        )
        const extracted = extractThreadFromDiscussionMessage(result)
        if (extracted) {
          logger.info('[discussionThreadResolver] resolved thread via GetDiscussionMessage', {
            chainId: chain.id,
            channelMsgId: mapping.tg_msg_id,
            maxMid: mapping.max_mid,
            channelKey,
            threadChatId: extracted.threadChatId,
            threadMsgId: extracted.threadMsgId,
          })
          return extracted
        }
      } catch (err: unknown) {
        const errText =
          err instanceof Error
            ? err.message
            : typeof err === 'object' && err !== null && 'errorMessage' in err
              ? String((err as { errorMessage?: string }).errorMessage ?? err)
              : String(err)
        if (isInvalidTelegramMessageIdError(errText)) {
          lastInvalidMsgId = true
          logger.debug('[discussionThreadResolver] GetDiscussionMessage MSG_ID_INVALID for channel key', {
            chainId: chain.id,
            channelMsgId: mapping.tg_msg_id,
            maxMid: mapping.max_mid,
            channelKey,
            errText,
          })
          continue
        }
        logger.warn('[discussionThreadResolver] GetDiscussionMessage failed', {
          chainId: chain.id,
          channelMsgId: mapping.tg_msg_id,
          maxMid: mapping.max_mid,
          channelKey,
          err,
        })
        return null
      }
    }

    if (lastInvalidMsgId) {
      logger.warn('[discussionThreadResolver] stale channel message id, dropping mapping', {
        chainId: chain.id,
        channelMsgId: mapping.tg_msg_id,
        maxMid: mapping.max_mid,
        channelKeysTried: channelKeys,
      })
      deletePostCommentMapping(mapping.chain_id, mapping.tg_msg_id)
      backfillPostCommentMappingForMaxMid(mapping.max_mid)
    }
    return null
  } finally {
    await disconnectTelegramUserClient(client)
  }
}

/**
 * Дополняет post_comment_mapping полями треда обсуждения, если они ещё не заданы.
 * @returns mapping с заполненными thread id или null, если восстановить не удалось
 */
export async function ensurePostThreadMapping(maxMid: string): Promise<PostCommentMappingRow | null> {
  return ensurePostThreadMappingInternal(maxMid, false)
}

/**
 * Принудительно пересоздаёт thread mapping (сбрасывает старые id и вызывает GetDiscussionMessage).
 */
export async function refreshPostThreadMapping(maxMid: string): Promise<PostCommentMappingRow | null> {
  return ensurePostThreadMappingInternal(maxMid, true)
}

async function ensurePostThreadMappingInternal(
  maxMid: string,
  forceRefresh: boolean,
): Promise<PostCommentMappingRow | null> {
  const normalized = maxMid.trim()
  if (!normalized) {
    return null
  }

  let mapping = findMappingByMaxMid(normalized)
  if (!mapping) {
    return null
  }

  if (forceRefresh && typeof mapping.tg_msg_id === 'number' && mapping.tg_msg_id > 0) {
    clearPostThreadMapping(mapping.chain_id, mapping.tg_msg_id)
    mapping = findMappingByMaxMid(normalized)
    if (!mapping) {
      return null
    }
  } else if (mapping.tg_thread_chat_id && mapping.tg_thread_msg_id) {
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
