/**
 * Строгая привязка комментариев к связке: строки удалённых/чужих связок не должны попадать в выбор цели.
 * Пишет в data/ рядом со скриптом — запускайте на копии проекта.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

process.env.BOT_TOKEN = 'test-token'
process.env.ADMIN_CHAT_ID = '1'
process.env.BOT_NICKNAME = 'test_bot'
process.env.NODE_ENV = 'development'

const root = path.resolve(__dirname, '..')
const dataDir = path.join(root, 'data')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })

const LIVE_A = 'aaaaaaaa-live-a'
const LIVE_B = 'bbbbbbbb-live-b'
const DEAD = 'dddddddd-deleted'
const MAX_A = -1001
const MAX_B = -1002
const TG_CH_A = '-100111'
const TG_CH_B = '-100222'

function chain(id: string, maxChat: number, tgChannel: string, discussion: string | null): Record<string, unknown> {
  return {
    id,
    max_chat_id: maxChat,
    max_title: id,
    tg_channel_id: tgChannel,
    tg_username: null,
    tg_discussion_chat_id: discussion,
    active: true,
    forward_posts: true,
    forward_comments: true,
    add_comments_button: true,
    created_at: new Date().toISOString(),
  }
}

async function main(): Promise<void> {
  const guard = await import('../src/services/commentLinkGuard')

  // --- чистая логика ---
  assert.equal(guard.sameMaxChat(-1001, 1001), true, 'знак не важен')
  assert.equal(guard.sameMaxChat(-1001, -1002), false)
  assert.equal(guard.sameMaxChat(0, 0), false)

  const liveA = chain(LIVE_A, MAX_A, TG_CH_A, '-500') as never
  const rowOf = (chain_id: string, thread: number | null) =>
    ({ chain_id, tg_msg_id: 1, max_mid: 'x', tg_chat_id: null, tg_thread_chat_id: thread, tg_thread_msg_id: thread ? 9 : null }) as never
  const picked = guard.pickLinkedMapping([rowOf(DEAD, -700), rowOf(LIVE_A, null)], [liveA], MAX_A)
  assert.equal(picked.mapping?.chain_id, LIVE_A, 'строка удалённой связки пропущена')
  assert.deepEqual(picked.rejected, [{ chainId: DEAD, reason: 'no_live_chain' }])
  const foreign = guard.pickLinkedMapping([rowOf(LIVE_A, -500)], [liveA], MAX_B)
  assert.equal(foreign.mapping, null, 'пост из другого MAX-канала не принадлежит связке')
  assert.equal(foreign.rejected[0]?.reason, 'max_chat_mismatch')
  assert.equal(guard.pickLinkedMapping([rowOf(DEAD, null)], [], MAX_A).mapping?.chain_id, DEAD, 'конфиг не загружен — без фильтра')
  assert.equal(guard.threadChatMismatch({ tg_thread_chat_id: -500 }, liveA), null)
  assert.deepEqual(guard.threadChatMismatch({ tg_thread_chat_id: -999 }, liveA), { expected: -500, actual: -999 })
  assert.equal(guard.threadChatMismatch({ tg_thread_chat_id: -999 }, chain(LIVE_A, MAX_A, TG_CH_A, null) as never), null, 'группа не задана — не блокируем')

  // --- БД + настройки связок ---
  fs.writeFileSync(
    path.join(dataDir, 'admin-panel-state.json'),
    JSON.stringify({ tg_chains: [chain(LIVE_A, MAX_A, TG_CH_A, '-500'), chain(LIVE_B, MAX_B, TG_CH_B, '-600')] }),
  )
  const { getDb, closeDb } = await import('../src/db/database')
  const db = getDb()
  const { ensureAdminPanelStateLoaded } = await import('../src/api/adminPanelState')
  await ensureAdminPanelStateLoaded()
  const store = await import('../src/services/postCommentMappingStore')

  const insChannel = db.prepare("INSERT INTO channels (chat_id, type, date_added) VALUES (?, 'channel', 'now')")
  insChannel.run(MAX_A)
  insChannel.run(MAX_B)
  const insPost = db.prepare(
    "INSERT INTO posts (post_id, chat_id, message_mid, text, comment_count, timestamp, data) VALUES (?, ?, ?, 't', 0, 'now', '{}')",
  )
  const insMap = db.prepare(
    'INSERT INTO post_comment_mapping (chain_id, tg_msg_id, max_mid, tg_chat_id, tg_thread_chat_id, tg_thread_msg_id) VALUES (?, ?, ?, ?, ?, ?)',
  )
  // p1: строка удалённой связки новее и с тредом, у живой — без треда: раньше побеждала удалённая.
  insPost.run('p1', MAX_A, 'mid1')
  insMap.run(LIVE_A, 1, 'mid1', -111, null, null)
  insMap.run(DEAD, 1, 'mid1', -111, -700, 55)
  // p2: только строка удалённой связки того же TG-канала → переносится на живую.
  insPost.run('p2', MAX_A, 'mid2')
  insMap.run(DEAD, 2, 'mid2', -100111, null, null)
  // p3: пост MAX-канала B, а маппинг из связки A (чужая) → игнорируется.
  insPost.run('p3', MAX_B, 'mid3')
  insMap.run(LIVE_A, 3, 'mid3', -100111, -500, 77)
  // p4: нормальный пост связки B.
  insPost.run('p4', MAX_B, 'mid4')
  insMap.run(LIVE_B, 4, 'mid4', -100222, -600, 88)

  const m1 = store.findMappingByMaxMid('mid1')!
  assert.equal(m1.chain_id, LIVE_A, 'выбрана живая связка, а не строка удалённой с тредом')
  assert.equal(m1.tg_thread_chat_id, null)
  assert.equal(store.findMappingByMaxMid('mid2'), null, 'только удалённая связка → нет цели')
  assert.equal(store.findMappingByMaxMid('mid3'), null, 'чужая связка → нет цели')
  assert.equal(store.findMappingByMaxMid('mid4')!.chain_id, LIVE_B)

  // Пересоздание маппинга не привязывает пост к чужой/удалённой связке.
  db.exec(`INSERT INTO tg_chain_forwarded (chain_id, tg_message_id, max_message_mid, tg_payload, forwarded_at)
           VALUES ('${DEAD}', 10, 'mid5', '{"chat":{"id":-100111}}', '2026-09-30 12:00:00'),
                  ('${LIVE_B}', 11, 'mid5', '{"chat":{"id":-100222}}', '2026-09-30 11:00:00'),
                  ('${LIVE_A}', 12, 'mid6', '{"chat":{"id":-100111}}', '2026-09-30 10:00:00')`)
  insPost.run('p5', MAX_B, 'mid5')
  insPost.run('p6', MAX_B, 'mid6') // связка A ведёт в MAX A, пост из B
  assert.equal(store.backfillPostCommentMappingForMaxMid('mid5'), true)
  assert.equal(store.findMappingByMaxMid('mid5')!.chain_id, LIVE_B)
  assert.equal(store.backfillPostCommentMappingForMaxMid('mid6'), false, 'нет связки MAX-канала поста')

  // Стартовый backfill не воскрешает строки удалённых связок.
  db.prepare('DELETE FROM post_comment_mapping WHERE chain_id = ?').run(DEAD)
  store.backfillPostCommentMappingsFromForwarded()
  const resurrected = db.prepare('SELECT COUNT(*) AS n FROM post_comment_mapping WHERE chain_id = ?').get(DEAD) as { n: number }
  assert.equal(resurrected.n, 0, 'удалённая связка не воскресает при старте')

  // Backfill при инициализации БД (каждый старт) тоже не воскрешает удалённые связки.
  db.exec(`INSERT INTO tg_chain_forwarded (chain_id, tg_message_id, max_message_mid) VALUES ('${DEAD}', 20, 'mid7')`)
  closeDb()
  const reopened = getDb()
  const revived = reopened.prepare('SELECT COUNT(*) AS n FROM post_comment_mapping WHERE chain_id = ?').get(DEAD) as { n: number }
  assert.equal(revived.n, 0, 'init backfill пропускает удалённые связки')
  const liveRevived = reopened.prepare("SELECT COUNT(*) AS n FROM post_comment_mapping WHERE max_mid = 'mid5' AND chain_id = ?").get(LIVE_B) as { n: number }
  assert.equal(liveRevived.n, 1, 'живые связки backfill по-прежнему заполняет')

  // --- CLI: отчёт не меняет БД, --fix чинит дубли и переносит ---
  reopened.prepare('DELETE FROM post_comment_mapping').run()
  reopened.prepare('DELETE FROM tg_chain_forwarded').run()
  const insMap2 = reopened.prepare(
    'INSERT INTO post_comment_mapping (chain_id, tg_msg_id, max_mid, tg_chat_id, tg_thread_chat_id, tg_thread_msg_id) VALUES (?, ?, ?, ?, ?, ?)',
  )
  insMap2.run(LIVE_A, 1, 'mid1', -100111, null, null)
  insMap2.run(DEAD, 1, 'mid1', -100111, -700, 55) // дубль (unique по chain_id+tg_msg_id для DEAD — другая связка)
  insMap2.run(DEAD, 2, 'mid2', -100111, null, null) // переносимая
  closeDb()

  const cli = path.join(root, 'src/cli/commentLinkAudit.ts')
  const run = (extra: string[]): string =>
    execFileSync('npx', ['ts-node', cli, ...extra], { cwd: root, encoding: 'utf8' })
  const report = run([])
  assert.match(report, /дубли строк живой связки: 1/)
  assert.match(report, /можно перенести на живую связку:  1/)
  assert.match(report, /ничего не изменено/)
  let count = (getDb().prepare('SELECT COUNT(*) AS n FROM post_comment_mapping').get() as { n: number }).n
  assert.equal(count, 3, 'отчёт ничего не меняет')
  closeDb()

  const fixed = run(['--fix'])
  assert.match(fixed, /Удалено дублей: 1/)
  assert.match(fixed, /перенесено на живую связку: 1/)
  const after = getDb()
    .prepare('SELECT chain_id, max_mid FROM post_comment_mapping ORDER BY max_mid')
    .all() as Array<{ chain_id: string; max_mid: string }>
  assert.deepEqual(after, [
    { chain_id: LIVE_A, max_mid: 'mid1' },
    { chain_id: LIVE_A, max_mid: 'mid2' },
  ])
  assert.ok(fs.readdirSync(path.join(dataDir, 'backups')).some((f) => f.startsWith('bot-before-link-repair-')), 'бэкап создан')
  closeDb()

  console.log('comment link guard: all checks passed')
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
