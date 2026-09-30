/**
 * Проверка thread_status в post_comment_mapping (вместо sentinel -1 в tg_thread_msg_id).
 * Пишет в data/ рядом со скриптом — запускайте на копии проекта.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const dataDir = path.resolve(__dirname, '../data')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })

async function main(): Promise<void> {
  const { getDb, closeDb } = await import('../src/db/database')
  let db = getDb()
  // Откат до легаси-схемы: sentinel -1 и без thread_status.
  db.exec(`
    ALTER TABLE post_comment_mapping DROP COLUMN thread_status;
    ALTER TABLE post_comment_mapping DROP COLUMN thread_status_at;
    INSERT INTO post_comment_mapping (chain_id, tg_msg_id, max_mid, tg_thread_chat_id, tg_thread_msg_id)
      VALUES ('c', 1, 'm1', NULL, -1), ('c', 2, 'm2', -1001, 500), ('c', 3, 'm3', NULL, NULL);
  `)
  closeDb()
  db = getDb()

  const store = await import('../src/services/postCommentMappingStore')

  const m1 = store.findMappingByMaxMid('m1')!
  assert.equal(m1.tg_thread_msg_id, null, 'sentinel -1 removed')
  assert.equal(m1.thread_status, 'stale')
  assert.equal(store.isMappingThreadResolveStale(m1), true)
  assert.equal(store.hasUsableThread(m1), false)

  const m2 = store.findMappingByMaxMid('m2')!
  assert.equal(store.hasUsableThread(m2), true)

  // stale не попадает в repair-список, пока TTL не истёк; m3 (без статуса) попадает.
  let missing = store.listMappingsMissingThread('c', 50).map((r) => r.max_mid).sort()
  assert.deepEqual(missing, ['m3'])
  db.prepare("UPDATE post_comment_mapping SET thread_status_at = 1 WHERE max_mid = 'm1'").run()
  missing = store.listMappingsMissingThread('c', 50).map((r) => r.max_mid).sort()
  assert.deepEqual(missing, ['m1', 'm3'], 'stale expires after TTL')
  assert.equal(store.isMappingThreadResolveStale(store.findMappingByMaxMid('m1')!), false)

  // suspect блокирует использование существующего id, но не стирает его.
  store.markMappingThreadSuspect('c', 2)
  const suspect = store.findMappingByMaxMid('m2')!
  assert.equal(suspect.tg_thread_msg_id, 500, 'ids kept')
  assert.equal(suspect.thread_status, 'suspect')
  assert.equal(store.hasUsableThread(suspect), false)
  db.prepare("UPDATE post_comment_mapping SET thread_status_at = 1 WHERE max_mid = 'm2'").run()
  assert.equal(store.hasUsableThread(store.findMappingByMaxMid('m2')!), true, 'suspect expires')

  // Успешная привязка сбрасывает статус.
  store.markMappingThreadResolveStale('c', 3)
  store.linkThreadMessageToChannelPost('c', 3, -1003, 900)
  const m3 = store.findMappingByMaxMid('m3')!
  assert.equal(m3.thread_status, null)
  assert.equal(store.hasUsableThread(m3), true)

  // Поиск по thread id учитывает чат.
  assert.equal(store.findMappingByThreadMsgId('c', 900, -1003)?.max_mid, 'm3')
  assert.equal(store.findMappingByThreadMsgId('c', 900, -9999), null)
  assert.equal(store.findMappingByThreadMsgId('c', 900)?.max_mid, 'm3')

  console.log('OK: thread status')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
