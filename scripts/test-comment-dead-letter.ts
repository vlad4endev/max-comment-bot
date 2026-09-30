/**
 * Проверка журнала dead-letter: запись, повтор, списание застарелых с возвратом.
 * Пишет в data/ и cwd/data — запускайте на копии проекта (см. docs/comment-sync-test-checklist.md).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const dataDir = path.resolve(__dirname, '../data')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })
fs.writeFileSync(
  path.join(process.cwd(), 'data', 'admin-panel-state.json'),
  JSON.stringify({
    tg_chains: [{ id: 'chainA', active: true, forward_comments: true, max_chat_id: 1, max_title: 'A' }],
  }),
)

async function main(): Promise<void> {
  const { ensureAdminPanelStateLoaded } = await import('../src/api/adminPanelState')
  await ensureAdminPanelStateLoaded()
  const { getDb } = await import('../src/db/database')
  const store = await import('../src/services/commentDeadLetterStore')
  const { purgeStaleUndeliverableComments } = await import('../src/services/commentSyncDiagnostics')
  const queue = await import('../src/services/tgChainForwardQueue')
  const { commentStore } = await import('../src/services/commentStore')
  const db = getDb()

  // tg_to_max: запись → повтор возвращает задачу в очередь входящих.
  const message = { message_id: 42, chat: { id: -1001 }, text: 'hello', message_thread_id: 7 }
  store.recordDeadLetter({
    direction: 'tg_to_max',
    kind: 'dead',
    chainId: 'chainA',
    refKey: '-1001:42',
    discussionChatId: -1001,
    tgMessageId: 42,
    reason: 'нет маппинга',
    attempts: 108,
    payload: JSON.stringify(message),
  })
  // Повторная запись того же ключа не плодит строки.
  store.recordDeadLetter({
    direction: 'tg_to_max', kind: 'dead', chainId: 'chainA', refKey: '-1001:42',
    discussionChatId: -1001, tgMessageId: 42, reason: 'нет маппинга', attempts: 109,
  })
  let open = store.listDeadLetters({ chainId: 'chainA' })
  assert.equal(open.length, 1)
  assert.equal(open[0]!.attempts, 109)
  assert.ok(open[0]!.payload, 'payload kept on re-record')

  assert.equal(queue.countCommentInboundJobs(), 0)
  assert.equal(store.retryDeadLetter(open[0]!.id), true)
  assert.equal(queue.countCommentInboundJobs(), 1)
  assert.equal(store.listDeadLetters({ chainId: 'chainA' }).length, 0)
  assert.equal(store.retryDeadLetter(open[0]!.id), false, 'already resolved')

  // skipped нельзя «повторить», но он виден и попадает в счётчики.
  store.recordDeadLetter({
    direction: 'tg_to_max', kind: 'skipped', chainId: 'chainA', refKey: '-1001:43', reason: 'бронь',
  })
  const skipped = store.listDeadLetters({ kind: 'skipped' })
  assert.equal(skipped.length, 1)
  assert.equal(store.retryDeadLetter(skipped[0]!.id), false)
  assert.deepEqual(store.countOpenDeadLetters(), [{ chain_id: 'chainA', kind: 'skipped', n: 1 }])

  // max_to_tg: застарелый комментарий списывается в журнал и может быть возвращён.
  db.pragma('foreign_keys = OFF')
  const old = '2020-01-01T00:00:00.000Z'
  db.prepare(
    "INSERT INTO posts (post_id, chat_id, message_mid, text, comment_count, timestamp, data) VALUES ('p1', 1, 'mid1', 't', 0, ?, '{}')",
  ).run(old)
  db.prepare(
    "INSERT INTO posts (post_id, chat_id, message_mid, text, comment_count, timestamp, data) VALUES ('p2', 999, 'mid2', 't', 0, ?, '{}')",
  ).run(old)
  const mine = commentStore.saveComment({ post_id: 'p1', user_id: 1, username: 'u', text: 'x' })
  const foreign = commentStore.saveComment({ post_id: 'p2', user_id: 1, username: 'u', text: 'y' })

  assert.equal(purgeStaleUndeliverableComments('chainA', 100), 1, 'only this chain comments purged')
  assert.ok((commentStore.getComment(mine.comment_id) as { tg_comment_id?: number }).tg_comment_id === undefined)
  const row = db.prepare('SELECT tg_comment_id FROM comments WHERE comment_id = ?').get(mine.comment_id) as { tg_comment_id: number }
  assert.ok(row.tg_comment_id < 0, 'written off with sentinel')
  const foreignRow = db.prepare('SELECT tg_comment_id FROM comments WHERE comment_id = ?').get(foreign.comment_id) as { tg_comment_id: number | null }
  assert.ok(foreignRow.tg_comment_id == null, 'foreign chat comment untouched')

  const dead = store.listDeadLetters({ chainId: 'chainA', kind: 'dead' })
  assert.equal(dead.length, 1)
  assert.equal(dead[0]!.comment_id, mine.comment_id)
  assert.equal(store.retryDeadLetter(dead[0]!.id), true)
  const back = db.prepare('SELECT tg_comment_id FROM comments WHERE comment_id = ?').get(mine.comment_id) as { tg_comment_id: number | null }
  assert.equal(back.tg_comment_id, null, 'sentinel removed, comment back in queue')

  // Ретенция: resolved/skipped старше 30 дней удаляются.
  db.prepare('UPDATE comment_sync_dead_letter SET created_at = 0').run()
  assert.ok(store.purgeOldDeadLetters() >= 2)

  // Задержки: три уровня.
  assert.equal(queue.commentMappingRetryDelayMs(1), queue.COMMENT_MAPPING_RETRY_MS)
  assert.equal(queue.commentMappingRetryDelayMs(30), queue.COMMENT_MAPPING_SLOW_RETRY_MS)
  assert.equal(queue.commentMappingRetryDelayMs(70), queue.COMMENT_MAPPING_VERY_SLOW_RETRY_MS)

  console.log('OK: comment dead-letter')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
