/**
 * Проверка независимых полос Telegram rate limiter и TTL-кэша.
 *   BOT_TOKEN=x ADMIN_CHAT_ID=1 BOT_NICKNAME=b OWNER_USER_ID=1 WEBHOOK_SECRET=abcdef \
 *     npx ts-node scripts/test-telegram-lanes.ts
 */
import assert from 'node:assert/strict'

import {
  enqueueTelegramApiCall,
  isTelegramApiPaused,
  pauseTelegramLane,
} from '../src/utils/telegramRateLimiter'
import { TtlCache } from '../src/utils/ttlCache'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  // Пауза одного токена не трогает другой.
  assert.equal(isTelegramApiPaused('tokA'), false)
  pauseTelegramLane('tokA', 30)
  assert.equal(isTelegramApiPaused('tokA'), true)
  assert.equal(isTelegramApiPaused('tokB'), false)

  // Долгий вызов на одной полосе не блокирует другую.
  const t0 = Date.now()
  const slow = enqueueTelegramApiCall('tokC', async () => {
    await sleep(600)
    return 'slow'
  })
  const fast = enqueueTelegramApiCall('tokD', async () => 'fast')
  assert.equal(await fast, 'fast')
  assert.ok(Date.now() - t0 < 400, 'other lane must not wait for the slow one')
  assert.equal(await slow, 'slow')

  // Внутри одной полосы порядок сохраняется.
  const order: number[] = []
  await Promise.all(
    [1, 2, 3].map((n) => enqueueTelegramApiCall('tokE', async () => void order.push(n))),
  )
  assert.deepEqual(order, [1, 2, 3])

  // TtlCache: null — валидное значение, истекает, потолок размера.
  const c = new TtlCache<string, number | null>(2)
  c.set('a', null, 30)
  assert.equal(c.get('a'), null)
  assert.equal(c.get('missing'), undefined)
  await sleep(50)
  assert.equal(c.get('a'), undefined)
  c.set('x', 1, 1000)
  c.set('y', 2, 1000)
  c.set('z', 3, 1000)
  assert.equal(c.get('x'), undefined)
  assert.equal(c.get('z'), 3)

  console.log('OK: telegram lanes + ttl cache')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
