import type { Bot } from '@maxhub/max-bot-api'
import type { Message } from '@maxhub/max-bot-api/types'

import { tryAttachCommentsToChannelPost, type AttachChannelCommentsResult } from './channelPostActions'
import { resolveCanonicalChannelChatId } from './resolveChannelChatId'
import { logger } from '../utils/logger'
import { apiCallWithRetry } from '../utils/maxApiRetry'
import { commentButtonStartappHasMid, postStore, type Post } from './postStore'

const GATE_VERIFY_ATTEMPTS = 5
const GATE_VERIFY_DELAY_MS = 250

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
  if (!commentButtonStartappHasMid(post.post_id, post.chat_id, post.message_mid)) {
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

/** Removes DB row(s) for this channel message and deletes MAX message(s) after a failed comment gate. */
export async function rollbackFailedChannelPost(
  bot: Bot,
  chatId: number,
  messageMid: string,
  postIdHint?: string,
  post?: Post | null,
): Promise<void> {
  const mid = messageMid.trim()
  const row =
    post ??
    postStore.findPostByChannelMessage(chatId, mid) ??
    (postIdHint?.trim() ? postStore.getPost(postIdHint.trim()) : null)

  if (row) {
    postStore.deletePostById(row.post_id)
  } else if (postIdHint?.trim()) {
    postStore.deletePostById(postIdHint.trim())
  }

  const mids = new Set<string>()
  if (mid !== '') {
    mids.add(mid)
  }
  if (row?.comments_ui_message_mid?.trim()) {
    mids.add(row.comments_ui_message_mid.trim())
  }
  for (const m of mids) {
    await tryDeleteMaxMessage(bot, m)
  }
}

async function waitForVerifiedPost(
  chatId: number,
  messageMid: string,
  attachResult: AttachChannelCommentsResult,
): Promise<Post | null> {
  for (let attempt = 0; attempt < GATE_VERIFY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await sleepMs(GATE_VERIFY_DELAY_MS * attempt)
    }
    const registered = postStore.findPostByChannelMessage(chatId, messageMid)
    if (
      registered !== null &&
      verifyPostCommentButtonReady(registered) &&
      attachOutcomeOk(attachResult)
    ) {
      return registered
    }
  }
  return postStore.findPostByChannelMessage(chatId, messageMid)
}

/**
 * After TG→MAX forward: attach button, verify Mini App lookup.
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

  const attachResult = await tryAttachCommentsToChannelPost(bot, message, {
    channelChatIdOverride: chatId,
    skipAuthorAdminCheck: true,
    source: 'tg_chain',
    inlineOnly: true,
  })

  const registered = await waitForVerifiedPost(chatId, mid, attachResult)
  const ready =
    registered !== null && verifyPostCommentButtonReady(registered) && attachOutcomeOk(attachResult)

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

  if (attachResult.ok && registered) {
    logger.warn('[tgChain] comment gate verify failed after attach — retry reattach', {
      chainId: context?.chainId,
      chatId,
      messageMid: mid,
      postId: registered.post_id,
    })
    const messageRetry = await loadChannelMessage(bot, chatId, mid)
    if (messageRetry?.body?.mid) {
      const retryAttach = await tryAttachCommentsToChannelPost(bot, messageRetry, {
        channelChatIdOverride: chatId,
        skipAuthorAdminCheck: true,
        source: 'tg_chain',
        inlineOnly: true,
      })
      const registeredRetry = await waitForVerifiedPost(chatId, mid, retryAttach)
      if (
        registeredRetry !== null &&
        verifyPostCommentButtonReady(registeredRetry) &&
        attachOutcomeOk(retryAttach)
      ) {
        logger.info('[tgChain] comment gate ok after reattach retry', {
          chainId: context?.chainId,
          chatId,
          messageMid: mid,
          postId: registeredRetry.post_id,
        })
        return true
      }
    }
  }

  logger.warn('[tgChain] comment gate failed — rollback MAX post', {
    chainId: context?.chainId,
    chatId,
    messageMid: mid,
    attachReason: attachResult.ok ? 'attached' : attachResult.reason,
    hasRow: Boolean(registered),
    rowPostId: registered?.post_id,
    pending: registered?.button_attach_pending ?? null,
  })

  await rollbackFailedChannelPost(bot, chatId, mid, registered?.post_id, registered)
  return false
}
