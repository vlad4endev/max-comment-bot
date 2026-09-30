/**
 * Восстановление текста/подписей TG-постов, испорченных старой версией «брони»
 * (до a8d7e67 маркер «🔒 Забронировано в МАКСе» писался поверх поста текстом из MAX).
 *
 * Берёт оригинал (текст + форматирование) из tg_chain_forwarded.tg_payload и правит пост в канале.
 * БД только читается. Правка идемпотентна: «message is not modified» = уже в порядке.
 *
 *   npx ts-node scripts/repair-booked-post-captions.ts                 # dry-run: только список, в Telegram ничего не шлёт
 *   npx ts-node scripts/repair-booked-post-captions.ts --apply         # реально править
 *
 * Опции (защита от нагрузки):
 *   --limit=N        максимум постов за запуск (по умолчанию 50)
 *   --delay-ms=N     пауза между правками (по умолчанию 2000, минимум 1000)
 *   --no-marker      вернуть чистый оригинал без «🔒 Забронировано…» (по умолчанию маркер сохраняется)
 *   --reset-state    забыть, какие посты уже обработаны
 *
 * Прогресс пишется в data/repair-captions-state.json — повторный запуск продолжает с места остановки.
 * Останавливается сам при 429 с большим retry_after или 5 ошибках подряд.
 * Запускайте в непиковое время, лучше при работающем боте (отдельный процесс, свой темп).
 */
import fs from 'node:fs'
import path from 'node:path'

import { telegramAxios as axios } from '../src/utils/telegramAxios'

const TG_API = 'https://api.telegram.org'
const TG_TEXT_LIMIT = 4096
const TG_CAPTION_LIMIT = 1024
const MARKER = '🔒 Забронировано в МАКСе'
const MAX_FLOOD_WAIT_S = 60
const MAX_CONSECUTIVE_ERRORS = 5
const STATE_PATH = path.resolve(__dirname, '../data/repair-captions-state.json')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function argNum(name: string, def: number, min: number): number {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`))
  const n = a ? Number.parseInt(a.split('=')[1] ?? '', 10) : NaN
  return Number.isFinite(n) ? Math.max(min, n) : def
}
const flag = (name: string) => process.argv.includes(`--${name}`)

type State = { done: string[] }
function loadState(): State {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as State
    return { done: Array.isArray(s.done) ? s.done : [] }
  } catch {
    return { done: [] }
  }
}
function saveState(s: State): void {
  fs.writeFileSync(STATE_PATH, JSON.stringify(s))
}

async function main(): Promise<void> {
  const apply = flag('apply')
  const withMarker = !flag('no-marker')
  const limit = argNum('limit', 50, 1)
  const delayMs = argNum('delay-ms', 2000, 1000)
  if (flag('reset-state')) fs.rmSync(STATE_PATH, { force: true })

  const { getDb } = await import('../src/db/database')
  const { ensureAdminPanelStateLoaded, listTgChainsSync } = await import('../src/api/adminPanelState')
  const { resolveTelegramBotToken } = await import('../src/services/resolveTelegramBotToken')
  const { findMappingByMaxMid } = await import('../src/services/postCommentMappingStore')
  const { appendBookingMarker } = await import('../src/utils/commentSyncFilter')

  await ensureAdminPanelStateLoaded()
  const db = getDb()
  const state = loadState()
  const done = new Set(state.done)

  const posts = db
    .prepare(
      `SELECT post_id, message_mid FROM posts
       WHERE json_extract(data, '$.tg_booked_in_max_applied') = 1
       ORDER BY created_at`,
    )
    .all() as Array<{ post_id: string; message_mid: string }>

  console.log(`Постов с маркером брони: ${posts.length}, уже обработано: ${done.size}, режим: ${apply ? 'APPLY' : 'dry-run'}`)

  const stats = { ok: 0, skipped: 0, failed: 0, pending: 0 }
  let processed = 0
  let consecutiveErrors = 0

  for (const p of posts) {
    if (done.has(p.post_id)) continue
    if (processed >= limit) {
      stats.pending++
      continue
    }

    const mapping = findMappingByMaxMid(p.message_mid)
    if (!mapping || !(mapping.tg_msg_id > 0)) {
      console.log(`- ${p.post_id}: нет привязки к TG-посту, пропуск`)
      stats.skipped++
      continue
    }
    const row = db
      .prepare('SELECT tg_payload FROM tg_chain_forwarded WHERE chain_id = ? AND tg_message_id = ?')
      .get(mapping.chain_id, mapping.tg_msg_id) as { tg_payload: string | null } | undefined
    let msg: {
      chat?: { id?: number }
      text?: string
      caption?: string
      entities?: unknown[]
      caption_entities?: unknown[]
    } | null = null
    try {
      msg = row?.tg_payload ? JSON.parse(row.tg_payload) : null
    } catch {
      msg = null
    }
    const hasText = typeof msg?.text === 'string' && msg.text.trim() !== ''
    const hasCaption = typeof msg?.caption === 'string' && msg.caption.trim() !== ''
    const chatId = mapping.tg_chat_id ?? msg?.chat?.id
    if (!msg || (!hasText && !hasCaption) || typeof chatId !== 'number') {
      // Часто — элемент альбома без подписи: подпись лежит на другом сообщении, автоматически не трогаем.
      console.log(`- ${p.post_id} (tg ${mapping.tg_msg_id}): нет исходного текста в payload, пропуск`)
      stats.skipped++
      continue
    }

    const isCaption = !hasText
    const original = (hasText ? msg.text : msg.caption) as string
    const entities = hasText ? msg.entities : msg.caption_entities
    // append сам делает trim() и сдвинул бы entities при ведущих пробелах — поэтому при сдвиге маркер не добавляем.
    const leadingShift = original.length - original.trimStart().length
    const target =
      withMarker && leadingShift === 0 ? appendBookingMarker(original, MARKER) : original
    const limitLen = isCaption ? TG_CAPTION_LIMIT : TG_TEXT_LIMIT
    if (target.length > limitLen) {
      console.log(`- ${p.post_id}: текст с маркером длиннее лимита Telegram, пропуск`)
      stats.skipped++
      continue
    }

    processed++
    if (!apply) {
      console.log(`· ${p.post_id} → ${isCaption ? 'caption' : 'text'} tg ${chatId}/${mapping.tg_msg_id} (${original.length} симв.)`)
      continue
    }

    const chain = listTgChainsSync().find((c) => c.id === mapping.chain_id)
    const token = chain?.bot_token?.trim() || resolveTelegramBotToken()
    if (!token) {
      console.log('Нет токена бота — останавливаюсь')
      break
    }

    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: mapping.tg_msg_id,
      [isCaption ? 'caption' : 'text']: target,
    }
    if (entities?.length) body[isCaption ? 'caption_entities' : 'entities'] = entities

    let stop = false
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await axios.post(`${TG_API}/bot${token}/${isCaption ? 'editMessageCaption' : 'editMessageText'}`, body, {
          timeout: 15_000,
        })
        console.log(`✓ ${p.post_id}`)
        stats.ok++
        consecutiveErrors = 0
        done.add(p.post_id)
        break
      } catch (err: unknown) {
        const data = (err as { response?: { data?: { description?: string; parameters?: { retry_after?: number } } } })
          .response?.data
        const desc = data?.description ?? String(err)
        if (/not modified/i.test(desc)) {
          console.log(`= ${p.post_id}: уже в порядке`)
          stats.ok++
          consecutiveErrors = 0
          done.add(p.post_id)
          break
        }
        const wait = data?.parameters?.retry_after
        if (wait) {
          if (wait > MAX_FLOOD_WAIT_S) {
            console.log(`429, retry_after=${wait}s — слишком долго, останавливаюсь. Запустите позже.`)
            stop = true
            break
          }
          console.log(`429, жду ${wait}s`)
          await sleep((wait + 1) * 1000)
          continue
        }
        console.log(`✗ ${p.post_id}: ${desc}`)
        stats.failed++
        consecutiveErrors++
        // Пост удалён/недоступен — повторять бессмысленно.
        if (/message to edit not found|message can't be edited|chat not found/i.test(desc)) done.add(p.post_id)
        break
      }
    }
    saveState({ done: [...done] })
    if (stop || consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) console.log('Слишком много ошибок подряд — остановка')
      break
    }
    await sleep(delayMs)
  }

  console.log(`Итого: исправлено ${stats.ok}, пропущено ${stats.skipped}, ошибок ${stats.failed}, осталось на след. запуск ${stats.pending}`)
  if (!apply) console.log('Это dry-run. Для реальной правки добавьте --apply')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
