/**
 * Проверка chat-scoped идентификаторов комментариев и аренды отправки.
 * ВАЖНО: пишет в data/bot.db относительно расположения файла — запускайте на копии
 * проекта (см. TESTING.md), а не на боевой БД.
 *   npx ts-node scripts/test-comment-sync-scope.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const dataDir = path.resolve(__dirname, '../data')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })

async function prepareLegacyDb(): Promise<void> {
  // Сначала создаём актуальную схему, затем откатываем её до легаси-вида.
  const { getDb, closeDb } = await import('../src/db/database')
  const db = getDb()
  db.pragma('foreign_keys = OFF')
  db.exec(`
    DROP INDEX IF EXISTS idx_comments_external_scoped;
    DROP TABLE IF EXISTS comment_sync_lease;
    ALTER TABLE comments DROP COLUMN tg_chat_id;
    CREATE UNIQUE INDEX idx_comments_tg_comment_id ON comments (tg_comment_id) WHERE tg_comment_id IS NOT NULL;
    INSERT INTO posts (post_id, chat_id, message_mid, text, comment_count, timestamp, data)
      VALUES ('p1', 1, 'mid1', 't', 0, '2026-01-01', '{}');
    INSERT INTO post_comment_mapping (chain_id, tg_msg_id, max_mid, tg_thread_chat_id, tg_thread_msg_id)
      VALUES ('chainA', 10, 'mid1', -1001, 500);
    INSERT INTO comments (comment_id, post_id, user_id, username, text, timestamp, data, tg_comment_id, source)
      VALUES ('legacy1', 'p1', 1, 'u', 'hi', '2026-01-01',
        '{"comment_id":"legacy1","post_id":"p1","user_id":1,"username":"u","text":"hi","timestamp":"2026-01-01"}',
        77, 'telegram');
  `)
  closeDb()
}

async function main(): Promise<void> {
  await prepareLegacyDb()
  const { getDb } = await import('../src/db/database')
  const { commentStore } = await import('../src/services/commentStore')
  const { acquireSyncLease, releaseSyncLease, withSyncLease } = await import(
    '../src/services/commentSyncLease'
  )
  const db = getDb()

  // Миграция: chat id восстановлен из mapping, старый глобальный индекс удалён.
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_comments_%'").all() as Array<{ name: string }>
  assert.ok(!idx.some((i) => i.name === 'idx_comments_tg_comment_id'), 'old global index dropped')
  assert.equal(commentStore.findCommentByTgMessage(-1001, 77)?.comment_id, 'legacy1')

  const base = { post_id: 'p1', user_id: 5, username: 'x', text: 'a' }

  // Один и тот же message_id в разных чатах — два разных комментария.
  const a = commentStore.saveTelegramThreadComment({ ...base, text: 'A' }, 1234, -1001)
  const b = commentStore.saveTelegramThreadComment({ ...base, text: 'B' }, 1234, -1002)
  assert.notEqual(a.comment_id, b.comment_id)
  assert.equal(commentStore.findCommentByTgMessage(-1001, 1234)?.text, 'A')
  assert.equal(commentStore.findCommentByTgMessage(-1002, 1234)?.text, 'B')

  // Повторное сохранение идемпотентно.
  const again = commentStore.saveTelegramThreadComment({ ...base, text: 'A2' }, 1234, -1001)
  assert.equal(again.comment_id, a.comment_id)
  assert.equal(commentStore.findCommentByTgMessage(-1001, 1234)?.text, 'A')

  // VK и TG с одинаковым id не конфликтуют.
  const vk = commentStore.saveVkThreadComment({ ...base, text: 'V' }, 1234, 999)
  assert.notEqual(vk.comment_id, a.comment_id)
  assert.equal(commentStore.findCommentByTgMessage(-1001, 1234)?.text, 'A')

  // MAX→TG: setTgCommentId пишет chat id, коллизии с другим чатом нет.
  const own = commentStore.saveComment({ ...base, text: 'own' })
  commentStore.setTgCommentId(own.comment_id, -1003, 1234, 'MAX · x: own')
  assert.equal(commentStore.findCommentByTgMessage(-1003, 1234)?.comment_id, own.comment_id)

  // Аренда: второй захват блокируется, после release — снова доступен, протухшая перехватывается.
  assert.equal(acquireSyncLease('k', 60_000), true)
  assert.equal(acquireSyncLease('k', 60_000), false)
  releaseSyncLease('k')
  assert.equal(acquireSyncLease('k', 60_000), true)
  db.prepare("UPDATE comment_sync_lease SET expires_at = 0 WHERE lease_key = 'k'").run()
  assert.equal(acquireSyncLease('k', 60_000), true)
  releaseSyncLease('k')

  let runs = 0
  const results = await Promise.all(
    [1, 2, 3].map(() =>
      withSyncLease('c1', async () => {
        runs += 1
        await new Promise((r) => setTimeout(r, 20))
        return 'done'
      }),
    ),
  )
  assert.equal(runs, 1)
  assert.equal(results.filter((r) => r === 'done').length, 1)

  console.log('OK: comment sync scope + lease')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
