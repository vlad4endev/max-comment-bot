import axios from 'axios'

import { listTgChainsSync, type TgChainRecord } from '../api/adminPanelState'
import {
  getTelegramUpdatesWithIds,
  TelegramGetUpdatesConflictError,
  type TgMessage,
} from '../forwarder/telegramReader'
import { isCommentSynced, markCommentSynced } from '../utils/commentSyncGuard'
import {
  isMaxAdminReplyInTelegram,
  isMaxCommentInTelegram,
  isTelegramCommentMarkedAnsweredInMax,
  isTgCommentFromAdmin,
  resolveTgCommentAuthor,
} from '../utils/commentSyncFilter'
import { logger } from '../utils/logger'
import { assertTelegramPollingReady } from './channelImportService'
import { ensureTelegramPollingMode } from './integrationPlatformClient'
import { resolveDiscussionChatId } from './postCommentMappingStore'
import { resolveCanonicalChannelChatId } from './resolveChannelChatId'
import {
  isTelegramAntispamBotConfigured,
  resolveTelegramAntispamBotToken,
} from './resolveTelegramAntispamBotToken'
import { resolveTelegramBotToken } from './resolveTelegramBotToken'
import { evaluateComment } from './antispamService'
import { enforceTelegramAntispamAction } from './telegramAntispamEnforcement'
import {
  getTelegramBotUpdatesOffset,
  setTelegramBotUpdatesOffset,
} from './telegramMainBotOffsetStore'

function isDiscussionAutoForwardMessage(message: TgMessage): boolean {
  return Boolean(
    message.is_automatic_forward ||
      message.forward_origin?.type === 'channel' ||
      (message.sender_chat && message.forward_from_message_id != null),
  )
}

export { isTelegramAntispamBotConfigured, resolveTelegramAntispamBotToken }

const TG_ANTISPAM_LONG_POLL_SEC = 25
const TG_ANTISPAM_IDLE_MS = 3_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function resolveEnforcementToken(chain: TgChainRecord, override?: string): string {
  const dedicated = resolveTelegramAntispamBotToken()
  if (dedicated) {
    return dedicated
  }
  return override?.trim() || chain.bot_token?.trim() || resolveTelegramBotToken()
}

/**
 * Проверка и блокировка спам-комментария в TG-обсуждении.
 * @returns true если комментарий заблокирован.
 */
export async function tryBlockTelegramCommentByAntispam(
  message: TgMessage,
  chain: TgChainRecord,
  discussionChatId: number,
  tgCommentId: number,
  enforcementToken?: string,
): Promise<boolean> {
  const text = (message.text || message.caption || '').trim()
  if (
    !text ||
    isMaxAdminReplyInTelegram(text) ||
    isMaxCommentInTelegram(text) ||
    isTelegramCommentMarkedAnsweredInMax(text)
  ) {
    return false
  }

  const token = resolveEnforcementToken(chain, enforcementToken)
  if (!token) {
    return false
  }

  const maxChatId = resolveCanonicalChannelChatId(chain.max_chat_id) ?? chain.max_chat_id
  const isAdmin = await isTgCommentFromAdmin(message, token, chain, discussionChatId)
  const { userId, username: authorName } = resolveTgCommentAuthor(
    message,
    chain,
    discussionChatId,
  )

  const antispam = evaluateComment({
    text,
    userId,
    username: authorName,
    channelChatId: maxChatId,
    source: 'telegram',
    isChannelAdmin: isAdmin,
  })

  if (antispam.allowed) {
    return false
  }

  const telegramUserId = typeof message.from?.id === 'number' ? message.from.id : null
  await enforceTelegramAntispamAction({
    token,
    chatId: message.chat.id,
    messageId: tgCommentId,
    telegramUserId,
    channelChatId: maxChatId,
    evaluation: antispam,
  })

  markCommentSynced(`tg:${tgCommentId}`)
  logger.info('[antispam/tg] blocked comment', {
    chainId: chain.id,
    tgCommentId,
    spamScore: antispam.spamScore,
    reason: antispam.reason,
    action: antispam.action,
    outcome: antispam.outcome,
    dedicatedBot: isTelegramAntispamBotConfigured(),
  })
  return true
}

async function buildDiscussionChainMap(token: string): Promise<Map<number, TgChainRecord[]>> {
  const map = new Map<number, TgChainRecord[]>()
  for (const chain of listTgChainsSync()) {
    if (!chain.active || !chain.forward_comments) {
      continue
    }
    const discussionId = await resolveDiscussionChatId(token, chain)
    if (discussionId == null) {
      continue
    }
    const list = map.get(discussionId) ?? []
    list.push(chain)
    map.set(discussionId, list)
  }
  return map
}

function pickChainForDiscussion(chains: TgChainRecord[]): TgChainRecord | null {
  return chains[0] ?? null
}

export async function runTelegramAntispamBotOnce(): Promise<boolean> {
  const token = resolveTelegramAntispamBotToken()
  if (!token) {
    return false
  }

  await ensureTelegramPollingMode(token)
  const pollErr = await assertTelegramPollingReady(token)
  if (pollErr) {
    logger.warn('[antispamBot] polling not ready', { err: pollErr })
    return false
  }

  const discussionMap = await buildDiscussionChainMap(token)
  if (discussionMap.size === 0) {
    return false
  }

  const offset = getTelegramBotUpdatesOffset(token)
  let batch
  try {
    batch = await getTelegramUpdatesWithIds(token, offset, TG_ANTISPAM_LONG_POLL_SEC, {
      includeDiscussionMessages: true,
    })
  } catch (err: unknown) {
    if (err instanceof TelegramGetUpdatesConflictError) {
      await sleep(10_000)
      return false
    }
    if (axios.isAxiosError(err) && err.response?.status === 409) {
      logger.warn('[antispamBot] 409 conflict — waiting 10s')
      await sleep(10_000)
      return false
    }
    throw err
  }

  let nextOffset = offset
  let handledAny = false

  for (const upd of batch) {
    nextOffset = Math.max(nextOffset, upd.update_id + 1)
    const msg = upd.message
    if (!msg) {
      continue
    }

    const chains = discussionMap.get(msg.chat.id)
    if (!chains?.length) {
      continue
    }
    if (isDiscussionAutoForwardMessage(msg)) {
      continue
    }
    if (!msg.reply_to_message) {
      continue
    }
    if (isCommentSynced(`tg:${msg.message_id}`)) {
      continue
    }

    const chain = pickChainForDiscussion(chains)
    if (!chain) {
      continue
    }

    const blocked = await tryBlockTelegramCommentByAntispam(
      msg,
      chain,
      msg.chat.id,
      msg.message_id,
      token,
    )
    if (blocked) {
      handledAny = true
    }
  }

  if (nextOffset > offset) {
    setTelegramBotUpdatesOffset(token, nextOffset)
  }

  return handledAny || batch.length > 0
}

let pollerStarted = false

export function startTelegramAntispamBotPoller(): () => void {
  if (!isTelegramAntispamBotConfigured()) {
    logger.info('[antispamBot] TG_ANTISPAM_BOT_TOKEN not set — antispam via main CommentBot')
    return () => {}
  }
  if (pollerStarted) {
    return () => {}
  }
  pollerStarted = true

  let stopped = false
  const loop = async () => {
    while (!stopped) {
      try {
        const hadUpdates = await runTelegramAntispamBotOnce()
        if (!hadUpdates) {
          await sleep(TG_ANTISPAM_IDLE_MS)
        }
      } catch (err: unknown) {
        if (err instanceof TelegramGetUpdatesConflictError) {
          logger.warn('[antispamBot] 409 conflict — waiting 10s')
          await sleep(10_000)
          continue
        }
        if (axios.isAxiosError(err) && err.response?.status === 409) {
          logger.warn('[antispamBot] 409 conflict — waiting 10s')
          await sleep(10_000)
          continue
        }
        logger.error('[antispamBot] loop error', { err })
        await sleep(TG_ANTISPAM_IDLE_MS)
      }
    }
  }

  void loop()
  logger.info('[antispamBot] dedicated antispam bot poller started')

  return () => {
    stopped = true
    pollerStarted = false
  }
}
