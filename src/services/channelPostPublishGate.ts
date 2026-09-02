import type { Bot } from '@maxhub/max-bot-api'
import type { Message } from '@maxhub/max-bot-api/types'

import { tryAttachCommentsToChannelPost, type AttachChannelCommentsResult } from './channelPostActions'
import { scheduleCommentButtonRetry } from './commentButtonRetryQueue'
import { resolveCanonicalChannelChatId } from './resolveChannelChatId'
import { logger } from '../utils/logger'
import { apiCallWithRetry } from '../utils/maxApiRetry'
import {
  commentButtonStartappHasMid,
  isBlankPostText,
  postStore,
  resolveChannelPostEditText,
  type Post,
} from './postStore'

const GATE_VERIFY_ATTEMPTS = 3
const GATE_VERIFY_DELAY_MS = 80

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

function keepPublishedAndRetryButton(chatId: number, messageMid: string, post: Post | null): true {
  if (post && post.button_attach_pending !== true) {
    postStore.savePost({ ...post, button_attach_pending: true })
  }
  scheduleCommentButtonRetry(chatId, messageMid)
  return true
}

/**
 * @deprecated Kept for admin/manual cleanup. Do not call after a live TG→MAX forward:
 * deleting the MAX post caused republish storms and broke miniapp lookup.
 */
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
 * After TG→MAX forward: attach the comments button.
 * Always keeps the published MAX post — a flaky button must not delete the post
 * or trigger a republish storm (that froze the bot and stalled the miniapp).
 *
 * @param knownCaption — text that was actually sent with `sendMessageToChat` (album/single).
 *   Used when `getMessage` briefly returns media without text right after publish.
 */
export async function attachAndVerifyCommentsForForwardedPost(
  bot: Bot,
  maxChatId: number,
  maxMessageMid: string,
  context?: { chainId?: string; knownCaption?: string },
): Promise<boolean> {
  const chatId = resolveCanonicalChannelChatId(maxChatId) ?? maxChatId
  const mid = maxMessageMid.trim()
  if (mid === '') {
    return false
  }

  const knownCaption = context?.knownCaption
  const knownText = isBlankPostText(knownCaption)
    ? undefined
    : resolveChannelPostEditText([knownCaption])

  let message = await loadChannelMessage(bot, chatId, mid)
  if (!message?.body?.mid) {
    logger.warn('[tgChain] comment gate: MAX getMessage empty after publish — keep post, retry button', {
      chainId: context?.chainId,
      chatId,
      messageMid: mid,
    })
    scheduleCommentButtonRetry(chatId, mid)
    return true
  }

  if (knownText && isBlankPostText(message.body.text)) {
    message = {
      ...message,
      body: {
        ...message.body,
        text: knownText,
      },
    }
    logger.info('[tgChain] comment gate: using knownCaption (API text empty)', {
      chainId: context?.chainId,
      chatId,
      messageMid: mid,
      textLen: knownText.length,
    })
  }

  const attachResult = await tryAttachCommentsToChannelPost(bot, message, {
    channelChatIdOverride: chatId,
    skipAuthorAdminCheck: true,
    source: 'tg_chain',
    inlineOnly: true,
    knownText,
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
    logger.warn('[tgChain] comment gate verify lagged after attach — keep post', {
      chainId: context?.chainId,
      chatId,
      messageMid: mid,
      postId: registered.post_id,
    })
    return true
  }

  // Media/caption often lag right after TG→MAX publish — retry inline once before reply stub.
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  logger.info('[tgChain] comment gate: inline retry after short delay', {
    chainId: context?.chainId,
    chatId,
    messageMid: mid,
    attachReason: attachResult.ok ? 'attached' : attachResult.reason,
  })
  const retryInline = await tryAttachCommentsToChannelPost(bot, message, {
    channelChatIdOverride: chatId,
    skipAuthorAdminCheck: true,
    source: 'tg_chain',
    inlineOnly: true,
    knownText,
  })
  const retryRegistered = await waitForVerifiedPost(chatId, mid, retryInline)
  if (
    retryRegistered !== null &&
    (attachOutcomeOk(retryInline) || verifyPostCommentButtonReady(retryRegistered))
  ) {
    logger.info('[tgChain] comment gate ok after delayed inline retry', {
      chainId: context?.chainId,
      chatId,
      messageMid: mid,
      postId: retryRegistered.post_id,
    })
    return true
  }

  logger.info('[tgChain] comment gate: inline failed — one reply fallback', {
    chainId: context?.chainId,
    chatId,
    messageMid: mid,
    attachReason: retryInline.ok ? 'attached' : retryInline.reason,
  })
  const fallbackResult = await tryAttachCommentsToChannelPost(bot, message, {
    channelChatIdOverride: chatId,
    skipAuthorAdminCheck: true,
    source: 'tg_chain',
    inlineOnly: false,
    knownText,
  })
  const fallbackRegistered = await waitForVerifiedPost(chatId, mid, fallbackResult)
  if (
    fallbackRegistered !== null &&
    (attachOutcomeOk(fallbackResult) || verifyPostCommentButtonReady(fallbackRegistered))
  ) {
    logger.info('[tgChain] comment gate ok after reply fallback', {
      chainId: context?.chainId,
      chatId,
      messageMid: mid,
      postId: fallbackRegistered.post_id,
    })
    return true
  }

  logger.warn('[tgChain] comment gate: button not ready — keep MAX post, retry attach', {
    chainId: context?.chainId,
    chatId,
    messageMid: mid,
    attachReason: fallbackResult.ok ? 'attached' : fallbackResult.reason,
    hasRow: Boolean(fallbackRegistered),
    rowPostId: fallbackRegistered?.post_id,
    pending: fallbackRegistered?.button_attach_pending ?? null,
  })

  return keepPublishedAndRetryButton(chatId, mid, fallbackRegistered ?? registered)
}
