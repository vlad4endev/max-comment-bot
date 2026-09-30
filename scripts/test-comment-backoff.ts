/**
 * Бэкофф отправки MAX→TG, продление аренды, отсутствие дублей в очереди.
 * ВАЖНО: пересоздаёт data/ — запускайте на копии проекта (см. TESTING.md).
 *   npx ts-node scripts/test-comment-backoff.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const dataDir = path.resolve(__dirname, '../data')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })

async function main(): Promise<void> {
  const { getDb } = await import('../src/db/database')
  const { commentStore } = await import('../src/services/commentStore')
  const backoff = await import('../src/services/commentSyncBackoff')
  const lease = await import('../src/services/commentSyncLease')
  const db = getDb()
  db.pragma('foreign_keys = OFF')

  db.exec(`
    INSERT INTO posts (post_id, chat_id, message_mid, text, comment_count, timestamp, data)
      VALUES ('p1', 1, 'mid1', 't', 0, '2026-01-01', '{}');
    INSERT INTO post_comment_mapping (chain_id, tg_msg_id, max_mid, tg_thread_chat_id, tg_thread_msg_id)
      VALUES ('chainA', 10, 'mid1', -1001, 500), ('chainA', 11, 'mid1', -1001, 501);
  `)
  const a = commentStore.saveComment({ post_id: 'p1', user_id: '1', username: 'a', text: 'A' } as never)
  const b = commentStore.saveComment({ post_id: 'p1', user_id: '2', username: 'b', text: 'B' } as never)

  // Два mapping-ряда на один пост не должны дублировать комментарии в батче.
  let ids = commentStore.listCommentsPendingMaxToTelegramForChat(1, 10).map((c) => c.comment_id)
  assert.deepEqual(new Set(ids).size, ids.length, 'no duplicate rows')
  assert.equal(ids.length, 2)

  // Упавший комментарий уходит в паузу, остальные не блокируются.
  const key = backoff.commentSendRetryKey('comment', a.comment_id)
  assert.equal(backoff.recordSendFailure(key), 1)
  assert.ok(backoff.isInBackoff(key))
  ids = commentStore.listCommentsPendingMaxToTelegramForChat(1, 10).map((c) => c.comment_id)
  assert.deepEqual(ids, [b.comment_id])

  // Экспонента растёт и ограничена.
  assert.ok(backoff.backoffDelayMs(2) > backoff.backoffDelayMs(1))
  assert.equal(backoff.backoffDelayMs(50), 60 * 60_000)

  backoff.clearSendFailure(key)
  assert.equal(commentStore.listCommentsPendingMaxToTelegramForChat(1, 10).length, 2)

  // Аренда: занята — нельзя; продление своей; освобождение.
  assert.equal(lease.acquireSyncLease('k', 60_000), true)
  assert.equal(lease.acquireSyncLease('k', 60_000), false)
  assert.equal(lease.renewSyncLease('k', 60_000), true)
  lease.releaseSyncLease('k')
  assert.equal(lease.renewSyncLease('k', 60_000), false)

  // Дубль внешнего комментария не считается созданным повторно.
  const first = commentStore.saveTelegramThreadCommentIfNew(
    { post_id: 'p1', user_id: '9', username: 'tg', text: 'x' } as never, 42, -1001)
  const second = commentStore.saveTelegramThreadCommentIfNew(
    { post_id: 'p1', user_id: '9', username: 'tg', text: 'x' } as never, 42, -1001)
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(first.comment.comment_id, second.comment.comment_id)

  console.log('✅ comment backoff/lease/dedupe checks passed')
}

void main()
