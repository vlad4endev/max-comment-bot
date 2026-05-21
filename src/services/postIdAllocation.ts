import { v4 as uuidv4 } from 'uuid'

import { postStore } from './postStore'

/** Stable `post_id` for `(chat_id, message_mid)`; reuses row id or a free `preferredPostId` from the button link. */
export function allocatePostIdForChannelMessage(
  chatId: number,
  messageMid: string,
  preferredPostId?: string,
): string {
  const existing = postStore.findPostByChannelMessage(chatId, messageMid)
  if (existing) {
    return existing.post_id
  }
  const preferred = preferredPostId?.trim()
  if (preferred && !postStore.getPost(preferred)) {
    return preferred
  }
  return uuidv4()
}
