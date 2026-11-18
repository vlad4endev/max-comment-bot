/**
 * Comment page + MAX→TG catch-up must use the canonical post id.
 * An old button link is an alias (`post_id_aliases`), not a row in `posts`.
 * Saving the comment under that alias returns 500 from incrementCommentCount,
 * hides the comment on GET /comments (loaded by the canonical id), and drops
 * it from listCommentsPendingMaxToTelegramForChat (INNER JOIN posts).
 *
 *   rm -rf data/ && TS_NODE_TRANSPILE_ONLY=1 npx ts-node scripts/test-comment-page-alias.ts
 */
import { CommentPostMissingError, commentStore } from '../src/services/commentStore'
import { postStore } from '../src/services/postStore'
import { rememberPostIdAlias, resolvePostByIdOrAlias } from '../src/services/postIdAliasStore'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    throw new Error(msg)
  }
}

const chatId = -100555
const canonicalId = 'mid.canonical-post'
const aliasId = 'Old-Button-Post-Id'

postStore.savePost({
  post_id: canonicalId,
  chat_id: chatId,
  message_mid: canonicalId,
  text: 'перенесённый пост',
  comment_count: 0,
  timestamp: new Date().toISOString(),
})
rememberPostIdAlias(aliasId, postStore.getPost(canonicalId)!)

const resolved = resolvePostByIdOrAlias(aliasId)
assert(resolved?.post_id === canonicalId, `alias must resolve to canonical, got ${resolved?.post_id}`)
assert(resolvePostByIdOrAlias(canonicalId)?.post_id === canonicalId, 'direct id stays canonical')
assert(resolvePostByIdOrAlias('missing-post') === null, 'unknown id stays missing')

const saved = commentStore.saveComment({
  post_id: resolved!.post_id,
  user_id: 42,
  username: 'reader',
  text: 'комментарий со старой кнопки',
})
assert(saved.post_id === canonicalId, `comment stored on ${saved.post_id}`)

const count = postStore.incrementCommentCount(resolved!.post_id)
assert(count === 1, `canonical count is ${count}, expected 1`)
assert(
  postStore.incrementCommentCount(aliasId) === null,
  'alias id is not a posts row, so counting it must not invent a counter',
)

const visible = commentStore.getComments(canonicalId)
assert(visible.length === 1 && visible[0]?.comment_id === saved.comment_id, 'page lists the comment on the canonical post')
assert(commentStore.getComments(aliasId).length === 0, 'alias id has no comment list of its own')

const pending = commentStore.listCommentsPendingMaxToTelegramForChat(chatId, 20)
assert(
  pending.length === 1 && pending[0]?.comment_id === saved.comment_id,
  `MAX→TG catch-up must see the comment, got ${pending.length}`,
)

const paired = commentStore.saveCommentWithPostCount({
  post_id: canonicalId,
  user_id: 43,
  username: 'reader',
  text: 'второй комментарий',
})
assert(paired.commentCount === 2, `counter after commit is ${paired.commentCount}`)
assert(postStore.getPost(canonicalId)?.comment_count === 2, 'posts.comment_count matches the insert')
assert(commentStore.getComments(canonicalId).length === 2, 'both comments stay on the canonical post')

let missingRolledBack = false
try {
  commentStore.saveCommentWithPostCount({
    post_id: 'no-such-post',
    user_id: 44,
    username: 'reader',
    text: 'не должен сохраниться',
  })
} catch (err: unknown) {
  missingRolledBack = err instanceof CommentPostMissingError
}
assert(missingRolledBack, 'missing post must abort the insert')
assert(commentStore.getComments('no-such-post').length === 0, 'rolled-back comment is not readable')
assert(commentStore.totalCount === 2, 'failed insert must not leave a row')

console.log('OK: comment page alias uses canonical post id and enters MAX→TG sync')
console.log('OK: comment and counter commit together, missing post rolls back')
process.exit(0)
