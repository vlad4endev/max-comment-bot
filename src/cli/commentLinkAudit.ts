/**
 * Аудит и починка привязок комментариев к связкам.
 *
 *   docker compose exec bot node dist/cli/commentLinkAudit.js            # только отчёт
 *   docker compose exec bot node dist/cli/commentLinkAudit.js --fix      # бэкап БД + починка
 *   ... --verbose                                                         # примеры проблемных постов
 *
 * Автоматически чинится только безопасное:
 *  - дубли строк post_comment_mapping от удалённых связок (у поста уже есть строка живой связки) — удаляются;
 *  - «осиротевшие» строки, у которых есть ровно одна живая связка того же TG-канала и MAX-канала, —
 *    переносятся на неё.
 * Остальное (тред не в группе обсуждения связки, пост из чужого MAX-канала) только показывается.
 */

import fs from 'node:fs'
import path from 'node:path'

import Database from 'better-sqlite3'

const DATA_DIR = path.resolve(__dirname, '../../data')
const DB_PATH = path.join(DATA_DIR, 'bot.db')
const STATE_PATH = path.join(DATA_DIR, 'admin-panel-state.json')

interface Chain {
  id: string
  max_title?: string | null
  max_chat_id: number | string
  tg_channel_id?: string | null
  tg_username?: string | null
  tg_discussion_chat_id?: string | null
  active?: boolean
  forward_comments?: boolean
}

interface MappingRow {
  id: number
  chain_id: string
  tg_msg_id: number
  max_mid: string
  tg_chat_id: number | null
  tg_thread_chat_id: number | null
  tg_thread_msg_id: number | null
  post_chat_id: number | null
}

const args = new Set(process.argv.slice(2))
const FIX = args.has('--fix')
const VERBOSE = args.has('--verbose')

function sameChat(a: unknown, b: unknown): boolean {
  const x = Number(a)
  const y = Number(b)
  return Number.isFinite(x) && Number.isFinite(y) && x !== 0 && Math.abs(x) === Math.abs(y)
}

function label(chain: Chain | undefined, id: string): string {
  return chain ? `${id.slice(0, 8)} «${chain.max_title ?? '?'}»` : `${id.slice(0, 8)} (удалена)`
}

function loadChains(): Chain[] {
  const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as { tg_chains?: Chain[] }
  return Array.isArray(raw.tg_chains) ? raw.tg_chains : []
}

function sample(rows: MappingRow[]): string {
  return rows
    .slice(0, 5)
    .map((r) => r.max_mid)
    .join(', ')
}

async function main(): Promise<void> {
  const chains = loadChains()
  const byId = new Map(chains.map((c) => [c.id, c]))
  const db = new Database(DB_PATH, { readonly: !FIX })
  db.pragma('busy_timeout = 10000')

  const rows = db
    .prepare(
      `SELECT m.id, m.chain_id, m.tg_msg_id, m.max_mid, m.tg_chat_id,
              m.tg_thread_chat_id, m.tg_thread_msg_id,
              (SELECT p.chat_id FROM posts p WHERE p.message_mid = m.max_mid LIMIT 1) AS post_chat_id
       FROM post_comment_mapping m
       WHERE m.max_mid != '__skipped__'`,
    )
    .all() as MappingRow[]

  console.log(`Связок в настройках: ${chains.length}, строк маппинга: ${rows.length}\n`)

  const liveRowsByMid = new Map<string, MappingRow[]>()
  for (const r of rows) {
    if (byId.has(r.chain_id)) {
      const list = liveRowsByMid.get(r.max_mid) ?? []
      list.push(r)
      liveRowsByMid.set(r.max_mid, list)
    }
  }
  const liveHasMatching = (mid: string): boolean =>
    (liveRowsByMid.get(mid) ?? []).some((r) => {
      const chain = byId.get(r.chain_id)!
      return r.post_chat_id == null || sameChat(chain.max_chat_id, r.post_chat_id)
    })

  // 1–2. Строки удалённых связок.
  const orphans = rows.filter((r) => !byId.has(r.chain_id))
  const duplicates = orphans.filter((r) => liveHasMatching(r.max_mid))
  const dupIds = new Set(duplicates.map((r) => r.id))
  const adoptable: Array<{ row: MappingRow; target: Chain }> = []
  const unclaimed: MappingRow[] = []
  for (const r of orphans) {
    if (dupIds.has(r.id)) continue
    const targets = chains.filter(
      (c) =>
        r.tg_chat_id != null &&
        String(c.tg_channel_id ?? '') === String(r.tg_chat_id) &&
        (r.post_chat_id == null || sameChat(c.max_chat_id, r.post_chat_id)),
    )
    if (targets.length === 1) adoptable.push({ row: r, target: targets[0]! })
    else unclaimed.push(r)
  }

  console.log('== Строки удалённых связок (в настройках их нет)')
  const orphanByChain = new Map<string, number>()
  for (const r of orphans) orphanByChain.set(r.chain_id, (orphanByChain.get(r.chain_id) ?? 0) + 1)
  if (orphans.length === 0) console.log('нет')
  for (const [id, n] of orphanByChain) console.log(`  ${id}: ${n} строк`)
  console.log(`  из них дубли строк живой связки: ${duplicates.length}`)
  console.log(`  можно перенести на живую связку:  ${adoptable.length}`)
  console.log(`  без подходящей связки:            ${unclaimed.length}`)
  if (VERBOSE && unclaimed.length) console.log(`  примеры без связки: ${sample(unclaimed)}`)

  // 3. Живые связки: пост из другого MAX-канала, чем в связке.
  console.log('\n== Пост из другого MAX-канала, чем у связки')
  let foreignTotal = 0
  for (const chain of chains) {
    const bad = rows.filter(
      (r) => r.chain_id === chain.id && r.post_chat_id != null && !sameChat(chain.max_chat_id, r.post_chat_id),
    )
    foreignTotal += bad.length
    if (bad.length) {
      console.log(`  ${label(chain, chain.id)}: ${bad.length} (MAX-канал связки ${chain.max_chat_id})`)
      if (VERBOSE) console.log(`    примеры: ${sample(bad)}`)
    }
  }
  if (foreignTotal === 0) console.log('нет')

  // 4. TG-канал в маппинге ≠ TG-каналу связки.
  console.log('\n== TG-канал в маппинге не совпадает с каналом связки')
  let chanTotal = 0
  for (const chain of chains) {
    if (!chain.tg_channel_id) continue
    const bad = rows.filter(
      (r) => r.chain_id === chain.id && r.tg_chat_id != null && String(r.tg_chat_id) !== String(chain.tg_channel_id),
    )
    chanTotal += bad.length
    if (bad.length) console.log(`  ${label(chain, chain.id)}: ${bad.length} (канал связки ${chain.tg_channel_id})`)
  }
  if (chanTotal === 0) console.log('нет')

  // 5. Группа обсуждения: в настройках и где реально лежат треды.
  console.log('\n== Группы обсуждения (настройки связки и реальные треды)')
  let discussionProblems = 0
  for (const chain of chains) {
    const configured = chain.tg_discussion_chat_id?.trim() || null
    const counts = new Map<number, number>()
    for (const r of rows) {
      if (r.chain_id === chain.id && r.tg_thread_chat_id) {
        counts.set(r.tg_thread_chat_id, (counts.get(r.tg_thread_chat_id) ?? 0) + 1)
      }
    }
    const threads = [...counts.entries()].map(([id, n]) => `${id}×${n}`).join(', ') || '—'
    const mismatch = [...counts.keys()].filter((id) => configured != null && String(id) !== configured)
    if (mismatch.length > 0) discussionProblems += 1
    console.log(
      `  ${mismatch.length ? '⚠' : '✓'} ${label(chain, chain.id)}: в связке ${configured ?? 'не задана'}; треды: ${threads}`,
    )
  }
  if (discussionProblems > 0) {
    console.log(
      '  ⚠ Тред лежит не в группе из настроек: MAX→TG для таких постов заблокирован до исправления.\n' +
        '    Проверьте в Telegram, какая группа реально привязана к каналу, и поправьте tg_discussion_chat_id.',
    )
  }

  if (!FIX) {
    console.log('\nРежим отчёта: ничего не изменено. Для починки дублей и переноса добавьте --fix.')
    db.close()
    return
  }

  const backupPath = path.join(DATA_DIR, 'backups', `bot-before-link-repair-${Date.now()}.db`)
  fs.mkdirSync(path.dirname(backupPath), { recursive: true })
  await db.backup(backupPath)
  console.log(`\nБэкап БД: ${backupPath}`)

  const del = db.prepare('DELETE FROM post_comment_mapping WHERE id = ?')
  const move = db.prepare('UPDATE post_comment_mapping SET chain_id = ? WHERE id = ?')
  const exists = db.prepare('SELECT 1 FROM post_comment_mapping WHERE chain_id = ? AND tg_msg_id = ?')
  let deleted = 0
  let moved = 0
  let movedDuplicate = 0
  db.transaction(() => {
    for (const r of duplicates) {
      deleted += Number(del.run(r.id).changes)
    }
    for (const { row, target } of adoptable) {
      if (exists.get(target.id, row.tg_msg_id)) {
        deleted += Number(del.run(row.id).changes)
        movedDuplicate += 1
      } else {
        moved += Number(move.run(target.id, row.id).changes)
      }
    }
  })()
  console.log(`Удалено дублей: ${deleted} (в т.ч. при переносе: ${movedDuplicate}), перенесено на живую связку: ${moved}`)
  console.log('Строки без подходящей связки не тронуты — findMappingByMaxMid их игнорирует.')
  db.close()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
