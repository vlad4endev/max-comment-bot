import { getDb } from '../db/database'
import { logger } from '../utils/logger'
import { postStore, type Post } from './postStore'

/**
 * Maps orphan `post_id` from an old button link → canonical row in `posts`.
 * Makes repeat Mini App opens instant after the first successful recovery.
 */
export function rememberPostIdAlias(aliasPostId: string, post: Post): void {
  const alias = aliasPostId.trim().toLowerCase()
  const canonical = post.post_id.trim().toLowerCase()
  if (!alias || !canonical || alias === canonical) {
    return
  }
  getDb()
    .prepare(
      `INSERT INTO post_id_aliases (alias_post_id, post_id, chat_id, message_mid)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(alias_post_id) DO UPDATE SET
         post_id = excluded.post_id,
         chat_id = excluded.chat_id,
         message_mid = excluded.message_mid`,
    )
    .run(alias, post.post_id, post.chat_id, post.message_mid)
  logger.info('postIdAlias: remembered orphan button post_id', {
    aliasPostId: alias,
    postId: post.post_id,
    chatId: post.chat_id,
    messageMid: post.message_mid,
  })
}

export function findPostByAlias(aliasPostId: string): Post | null {
  const alias = aliasPostId.trim()
  if (!alias) {
    return null
  }
  const row = getDb()
    .prepare('SELECT post_id FROM post_id_aliases WHERE alias_post_id = ?')
    .get(alias) as { post_id: string } | undefined
  if (!row) {
    const lower = alias.toLowerCase()
    if (lower !== alias) {
      const rowLower = getDb()
        .prepare('SELECT post_id FROM post_id_aliases WHERE alias_post_id = ?')
        .get(lower) as { post_id: string } | undefined
      if (rowLower) {
        return postStore.getPost(rowLower.post_id)
      }
    }
    return null
  }
  return postStore.getPost(row.post_id)
}
