/**
 * Кросс-платформенная бронь поста: при первом комментарии на одной платформе
 * помечаем пост на MAX, Telegram и VK.
 *
 * Закрытие комментариев в MAX при брони TG/VK действует ограниченное время
 * ({@link getCommentsBookingLockHours}, по умолчанию 8 часов), затем в MAX
 * снова можно писать. Поле `comments_booked_by` при этом сохраняется.
 */

import type { Bot } from '@maxhub/max-bot-api'

import { listVkChainsSync } from '../api/adminPanelState'
import { bookingMarkerForTelegram, bookingMarkerForVk } from '../utils/commentSyncFilter'
import { logger } from '../utils/logger'
import {
  getCommentsBookingLockHours,
  isCommentsBookingActive,
  type CommentsBookingLockFields,
} from './commentsBookingLock'
import { appendMarkerToVkWallPost } from './integrationPlatformClient'
import type { CommentsBookedBy, Post } from './postStore'
import { postStore } from './postStore'
import { applyTelegramPostBookingMarker } from './telegramPostMarker'
import { vkPostMappingStore } from './vkPostMappingStore'

export {
  commentsClosedUntilIso,
  getCommentsBookingLockHours,
  getCommentsBookingLockMs,
  isCommentsBookingActive,
} from './commentsBookingLock'
export type { CommentsBookingLockFields as CommentsBookingFields } from './commentsBookingLock'

export async function claimAndPropagateCommentsBooking(
  postId: string,
  by: CommentsBookedBy,
  bot?: Bot,
): Promise<boolean> {
  const claimed = postStore.tryClaimCommentsBooking(postId, by)
  if (!claimed) {
    return false
  }
  await propagateCommentsBooking(postId, by, bot)
  return true
}

export async function propagateCommentsBooking(
  postId: string,
  bookedBy: CommentsBookedBy,
  bot?: Bot,
): Promise<void> {
  const post = postStore.getPost(postId)
  if (!post) {
    return
  }

  const tasks: Promise<void>[] = []

  if (bookedBy === 'telegram' || bookedBy === 'vk') {
    if (bot) {
      tasks.push(
        postStore
          .updateButtonCaption(bot, post)
          .then(() => undefined)
          .catch((err: unknown) => {
            logger.warn('[commentsBooking] MAX button update failed', { postId, bookedBy, err })
          }),
      )
    }
  }

  const tgMarker = bookingMarkerForTelegram(bookedBy)
  if (tgMarker) {
    tasks.push(
      applyTelegramPostBookingMarker(post, tgMarker)
        .then(() => undefined)
        .catch((err: unknown) => {
          logger.warn('[commentsBooking] TG marker failed', { postId, bookedBy, err })
        }),
    )
  }

  tasks.push(applyVkPostBookingMarkers(post, bookedBy))

  await Promise.all(tasks)
}

async function applyVkPostBookingMarkers(post: Post, bookedBy: CommentsBookedBy): Promise<void> {
  const marker = bookingMarkerForVk(bookedBy)
  if (!marker) {
    return
  }

  await vkPostMappingStore.load().catch(() => undefined)

  const chains = listVkChainsSync().filter((c) => c.active)
  const seen = new Set<string>()

  for (const chain of chains) {
    if (Math.abs(chain.max_chat_id) !== Math.abs(post.chat_id)) continue
    for (const mapping of vkPostMappingStore.listByChain(chain.id)) {
      if (mapping.maxMid !== post.message_mid) continue
      const key = `${chain.id}:${mapping.vkPostId}`
      if (seen.has(key)) continue
      seen.add(key)

      const ok = await appendMarkerToVkWallPost(
        chain.vk_token,
        chain.vk_group_id,
        mapping.vkPostId,
        marker,
      )
      if (ok) {
        logger.info('[commentsBooking] VK post marked', {
          postId: post.post_id,
          bookedBy,
          vkPostId: mapping.vkPostId,
          groupId: chain.vk_group_id,
        })
      } else {
        logger.warn('[commentsBooking] VK post marker failed', {
          postId: post.post_id,
          bookedBy,
          vkPostId: mapping.vkPostId,
          groupId: chain.vk_group_id,
        })
      }
    }
  }
}

/** Можно ли синхронизировать комментарии с платформы `from`, если пост забронирован другой платформой. */
export function isCommentSyncBlockedByBooking(
  post: CommentsBookingLockFields,
  from: CommentsBookedBy,
): boolean {
  if (!isCommentsBookingActive(post)) {
    return false
  }
  const bookedBy = post.comments_booked_by
  if (!bookedBy || bookedBy === from) {
    return false
  }
  return true
}

export function commentsClosedInMaxMessage(bookedBy: CommentsBookedBy | undefined): string {
  const hours = getCommentsBookingLockHours()
  const hoursLabel = Number.isInteger(hours) ? String(hours) : hours.toFixed(1)
  if (bookedBy === 'telegram') {
    return `Комментарии временно закрыты на ${hoursLabel} ч. Обсуждение ведётся в Telegram.`
  }
  if (bookedBy === 'vk') {
    return `Комментарии временно закрыты на ${hoursLabel} ч. Обсуждение ведётся во ВКонтакте.`
  }
  return `Комментарии временно закрыты на ${hoursLabel} ч.`
}
