/**
 * Пауза между повторами переноса TG→MAX: «зависший» пост не должен повторяться каждые 16 секунд.
 * Пишет в data/ рядом со скриптом — запускайте на копии проекта.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

process.env.BOT_TOKEN = 'test-token'
process.env.ADMIN_CHAT_ID = '1'
process.env.BOT_NICKNAME = 'test_bot'

const dataDir = path.resolve(__dirname, '../data')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })

async function main(): Promise<void> {
  const queue = await import('../src/services/tgChainForwardQueue')
  const s = 1_000
  const m = 60 * s

  // Первые 5 попыток — прежний быстрый график.
  assert.deepEqual([1, 2, 3, 4, 5].map(queue.forwardRetryDelayMs), [1 * s, 2 * s, 4 * s, 8 * s, 16 * s])
  // Дальше растёт до потолка 30 минут и не убывает.
  assert.deepEqual(
    [6, 7, 8, 9, 10, 11].map(queue.forwardRetryDelayMs),
    [30 * s, 1 * m, 2 * m, 4 * m, 8 * m, 16 * m],
  )
  assert.equal(queue.forwardRetryDelayMs(12), 30 * m)
  assert.equal(queue.forwardRetryDelayMs(62_341), 30 * m, 'боевой случай: 62 341 попытка')
  let prev = 0
  for (let a = 1; a < 200; a += 1) {
    const d = queue.forwardRetryDelayMs(a)
    assert.ok(d >= prev && d <= 30 * m, `attempt ${a}`)
    prev = d
  }
  // Комментарии и прочие очереди по-прежнему используют retryDelayMs (потолок 16 с).
  assert.equal(queue.retryDelayMs(62_341), 16 * s)

  // Реальная строка очереди с 62 340 попытками получает паузу 30 минут.
  const { getDb, closeDb } = await import('../src/db/database')
  const db = getDb()
  db.prepare(
    `INSERT INTO tg_chain_forward_queue (job_key, chain_id, tg_token, payload, attempts, next_retry_at, created_at)
     VALUES ('stuck', 'chain', 't', '[]', 62340, 0, 0)`,
  ).run()
  const before = Date.now()
  const attempts = queue.bumpForwardQueueRetry('stuck', new Error('MAX publish incomplete'))
  assert.equal(attempts, 62_341)
  const row = db.prepare("SELECT next_retry_at FROM tg_chain_forward_queue WHERE job_key = 'stuck'").get() as {
    next_retry_at: number
  }
  assert.ok(row.next_retry_at - before >= 30 * m - 1_000 && row.next_retry_at - before <= 30 * m + 5_000)
  closeDb()

  console.log('forward retry backoff: all checks passed')
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
