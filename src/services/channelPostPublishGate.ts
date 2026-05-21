import type { Bot } from '@maxhub/max-bot-api'
import type { Message } from '@maxhub/max-bot-api/types'
import { v4 as uuidv4 } from 'uuid'

import {
  buildPostFromChannelMessage,
  tryAttachCommentsToChannelPost,
  type AttachChannelCommentsResult,
} from './channelPostActions'
import { scheduleCommentButtonRetry } from './commentButtonRetryQueue'
import { resolveCanonicalChannelChatId } from './resolveChannelChatId'
import { logger } from '../utils/logger'
import { apiCallWithRetry } from '../utils/maxApiRetry'
import { buildMiniAppUrl, postStore, type Post } from './postStore'

const GATE_LOOKUP_RETRY_MS = 400

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function loadChannelMessage(bot: Bot, chatId: number, messageMid: string): Promise<Message | null> {
  try {
    return await bot.api.getMessage(messageMid)
  } catch {
    try {
      const { messages } = await apiCallWithRetry(() =>
        bot.api.getMessages(chatId, { message_ids: [messageMid] }),
      )
      return messages[0] ?? null
    } catch (err: unknown) {
      logger.warn('channelPostPublishGate: could not load MAX message', {
        chatId,
        messageMid,
        err,
      })
      return null
    }
  }
}

/** Post row exists, ids align, startapp has `_mid_`, button attach is not pending. */
export function verifyPostCommentButtonReady(post: Post): boolean {
  const byId = postStore.getPost(post.post_id)
  if (!byId || byId.post_id !== post.post_id) {
    return false
  }
  const byMid = postStore.findPostByChannelMessage(post.chat_id, post.message_mid)
  if (!byMid || byMid.post_id !== post.post_id) {
    return false
  }
  if (byMid.button_attach_pending === true) {
    return false
  }
  try {
    const url = buildMiniAppUrl(post.post_id, post.chat_id, undefined, post.message_mid)
    const startParam = new URL(url).searchParams.get('startapp') ?? ''
    if (!startParam.includes('_mid_')) {
      return false
    }
  } catch {
    return false
  }
  return postStore.findPost(post.post_id, post.chat_id) !== null
}

function attachOutcomeOk(r: AttachChannelCommentsResult): boolean {
  return r.ok || r.reason === 'already_exists'
}

async function tryDeleteMaxMessage(bot: Bot, messageMid: string): Promise<void> {
  try {
    await apiCallWithRetry(() => bot.api.deleteMessage(messageMid))
  } catch (err: unknown) {
    logger.warn('channelPostPublishGate: deleteMessage failed', { messageMid, err })
  }
}

/** Removes MAX message(s) and DB row after a failed comment gate. */
export async function rollbackFailedChannelPost(
  bot: Bot,
  chatId: number,
  messageMid: string,
  postId: string,
  post?: Post | null,
): Promise<void> {
  const row = post ?? postStore.getPost(postId)
  const mids = new Set<string>()
  mids.add(messageMid.trim())
  if (row?.comments_ui_message_mid?.trim()) {
    mids.add(row.comments_ui_message_mid.trim())
  }
  for (const mid of mids) {
    if (mid !== '') {
      await tryDeleteMaxMessage(bot, mid)
    }
  }
  postStore.deletePostById(postId)
}

/**
 * After TG→MAX forward: save post with fixed `post_id`, attach button, verify Mini App lookup.
 * On failure deletes the MAX post and DB row so the TG message can be forwarded again.
 */
export async function attachAndVerifyCommentsForForwardedPost(
  bot: Bot,
  maxChatId: number,
  maxMessageMid: string,
  context?: { chainId?: string },
): Promise<boolean> {
  const chatId = resolveCanonicalChannelChatId(maxChatId) ?? maxChatId
  const mid = maxMessageMid.trim()
  if (mid === '') {
    return false
  }

  const message = await loadChannelMessage(bot, chatId, mid)
  if (!message?.body?.mid) {
    await tryDeleteMaxMessage(bot, mid)
    return false
  }

  const postId = uuidv4()
  const draft: Post = {
    ...buildPostFromChannelMessage(message, chatId, postId, undefined),
    button_attach_pending: true,
  }
  postStore.savePost(draft)

  const attachResult = await tryAttachCommentsToChannelPost(bot, message, {
    channelChatIdOverride: chatId,
    skipAuthorAdminCheck: true,
    source: 'tg_chain',
    inlineOnly: true,
  })

  await sleepMs(GATE_LOOKUP_RETRY_MS)

  const registered = postStore.findPostByChannelMessage(chatId, mid)
  const ready = registered !== null && verifyPostCommentButtonReady(registered) && attachOutcomeOk(attachResult)

  if (ready) {
    logger.info('[tgChain] comment gate ok', {
      chainId: context?.chainId,
      chatId,
      messageMid: mid,
      postId: registered.post_id,
      attachReason: attachResult.ok ? 'attached' : attachResult.reason,
    })
    return true
  }

  logger.warn('[tgChain] comment gate failed — rollback MAX post', {
    chainId: context?.chainId,
    chatId,
    messageMid: mid,
    postId,
    attachReason: attachResult.ok ? 'attached' : attachResult.reason,
    hasRow: Boolean(registered),
    rowPostId: registered?.post_id,
    pending: registered?.button_attach_pending ?? null,
  })

  await rollbackFailedChannelPost(bot, chatId, mid, postId, registered ?? draft)
  scheduleCommentButtonRetry(chatId, mid)
  return false
}
