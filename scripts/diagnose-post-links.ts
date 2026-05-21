import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

import Database from 'better-sqlite3'

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | string

interface RuntimeLogEntry {
  ts?: string
  level?: LogLevel
  message?: string
  extra?: Record<string, unknown>
}

interface PostRow {
  post_id: string
  chat_id: number
  message_mid: string
  timestamp: string
}

interface LogSignal {
  kind: 'id_mismatch' | 'post_lookup_not_found'
  ts?: string
  requestedPostId?: string
  foundPostId?: string
  chatId?: number
  messageMid?: string
}

interface RefreshCandidate {
  postId?: string
  chatId?: number
  messageMid?: string
  reasons: Set<string>
  signals: number
}

const CWD = process.cwd()
const DB_PATH = path.join(CWD, 'data', 'bot.db')
const RUNTIME_LOG_PATH = path.join(CWD, 'data', 'runtime.log')

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return null
  }
  return v as Record<string, unknown>
}

function asNonEmptyString(v: unknown): string | undefined {
  if (typeof v !== 'string') {
    return undefined
  }
  const t = v.trim()
  return t === '' ? undefined : t
}

function asInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isInteger(v)) {
    return v
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number.parseInt(v, 10)
    if (Number.isInteger(n)) {
      return n
    }
  }
  return undefined
}

function candidateKey(postId?: string, chatId?: number, messageMid?: string): string {
  const p = postId ?? '?'
  const c = chatId !== undefined ? String(chatId) : '?'
  const m = messageMid ?? '?'
  return `${p}|${c}|${m}`
}

function addCandidate(
  map: Map<string, RefreshCandidate>,
  params: { postId?: string; chatId?: number; messageMid?: string; reason: string },
): void {
  const key = candidateKey(params.postId, params.chatId, params.messageMid)
  const existing = map.get(key)
  if (existing) {
    existing.reasons.add(params.reason)
    existing.signals += 1
    return
  }
  map.set(key, {
    postId: params.postId,
    chatId: params.chatId,
    messageMid: params.messageMid,
    reasons: new Set([params.reason]),
    signals: 1,
  })
}

async function parseRuntimeLogSignals(logPath: string): Promise<LogSignal[]> {
  if (!fs.existsSync(logPath)) {
    return []
  }
  const stream = fs.createReadStream(logPath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  const out: LogSignal[] = []

  for await (const lineRaw of rl) {
    const line = lineRaw.trim()
    if (line === '') {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line) as unknown
    } catch {
      continue
    }
    const row = asRecord(parsed) as RuntimeLogEntry | null
    if (!row) {
      continue
    }
    const message = asNonEmptyString(row.message)
    if (!message) {
      continue
    }
    const extra = asRecord(row.extra)

    if (message.includes('post_id в ссылке не совпадает')) {
      out.push({
        kind: 'id_mismatch',
        ts: asNonEmptyString(row.ts),
        requestedPostId: asNonEmptyString(extra?.requestedPostId),
        foundPostId: asNonEmptyString(extra?.postId),
        chatId: asInt(extra?.chatId),
        messageMid: asNonEmptyString(extra?.messageMid),
      })
      continue
    }

    if (message === 'miniapp: post lookup' && extra?.found === false) {
      out.push({
        kind: 'post_lookup_not_found',
        ts: asNonEmptyString(row.ts),
        requestedPostId: asNonEmptyString(extra.receivedPostId ?? extra.identifier),
        chatId: asInt(extra.chatId),
        messageMid: asNonEmptyString(extra.messageMid),
      })
    }
  }

  return out
}

function getPostById(db: Database.Database, postId: string): PostRow | null {
  const row = db.prepare(
    'SELECT post_id, chat_id, message_mid, timestamp FROM posts WHERE post_id = ? LIMIT 1',
  ).get(postId) as PostRow | undefined
  return row ?? null
}

function getPostByChatAndMid(db: Database.Database, chatId: number, messageMid: string): PostRow | null {
  const row = db.prepare(
    `SELECT post_id, chat_id, message_mid, timestamp
     FROM posts
     WHERE ABS(chat_id) = ABS(?) AND message_mid = ?
     ORDER BY timestamp DESC, post_id DESC
     LIMIT 1`,
  ).get(chatId, messageMid) as PostRow | undefined
  return row ?? null
}

function printHeader(title: string): void {
  console.log(`\n=== ${title} ===`)
}

async function main(): Promise<void> {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found: ${DB_PATH}`)
    process.exit(1)
  }
  const db = new Database(DB_PATH, { readonly: true })
  try {
    const postCount = Number((db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n ?? 0)
    const commentCount = Number(
      (db.prepare('SELECT COUNT(*) AS n FROM comments').get() as { n: number }).n ?? 0,
    )
    console.log('Диагностика ссылок комментариев')
    console.log(`DB: ${DB_PATH}`)
    console.log(`Posts: ${postCount}, Comments: ${commentCount}`)

    const orphanCommentRefs = db.prepare(
      `SELECT c.post_id AS post_id, COUNT(*) AS cnt
       FROM comments c
       LEFT JOIN posts p ON p.post_id = c.post_id
       WHERE p.post_id IS NULL
       GROUP BY c.post_id
       ORDER BY cnt DESC, c.post_id ASC`,
    ).all() as Array<{ post_id: string; cnt: number }>

    const duplicateByAbsChatMid = db.prepare(
      `SELECT ABS(chat_id) AS abs_chat_id, message_mid, COUNT(*) AS cnt
       FROM posts
       GROUP BY ABS(chat_id), message_mid
       HAVING COUNT(*) > 1
       ORDER BY cnt DESC, abs_chat_id ASC`,
    ).all() as Array<{ abs_chat_id: number; message_mid: string; cnt: number }>

    const signals = await parseRuntimeLogSignals(RUNTIME_LOG_PATH)
    const candidates = new Map<string, RefreshCandidate>()

    for (const s of signals) {
      if (s.kind === 'id_mismatch') {
        const target =
          (s.chatId !== undefined && s.messageMid)
            ? getPostByChatAndMid(db, s.chatId, s.messageMid)
            : (s.foundPostId ? getPostById(db, s.foundPostId) : null)
        addCandidate(candidates, {
          postId: target?.post_id ?? s.foundPostId,
          chatId: target?.chat_id ?? s.chatId,
          messageMid: target?.message_mid ?? s.messageMid,
          reason: 'log:id_mismatch',
        })
      } else if (s.kind === 'post_lookup_not_found') {
        const target =
          (s.chatId !== undefined && s.messageMid)
            ? getPostByChatAndMid(db, s.chatId, s.messageMid)
            : (s.requestedPostId ? getPostById(db, s.requestedPostId) : null)
        addCandidate(candidates, {
          postId: target?.post_id ?? s.requestedPostId,
          chatId: target?.chat_id ?? s.chatId,
          messageMid: target?.message_mid ?? s.messageMid,
          reason: 'log:post_lookup_not_found',
        })
      }
    }

    for (const d of duplicateByAbsChatMid) {
      addCandidate(candidates, {
        chatId: d.abs_chat_id,
        messageMid: d.message_mid,
        reason: 'db:duplicate_abs_chat_mid',
      })
    }

    printHeader('Сигналы из runtime.log')
    console.log(`signals=${signals.length}`)
    const mismatch = signals.filter((s) => s.kind === 'id_mismatch').length
    const notFound = signals.filter((s) => s.kind === 'post_lookup_not_found').length
    console.log(`id_mismatch=${mismatch}, post_lookup_not_found=${notFound}`)

    printHeader('Проблемы в БД')
    console.log(`orphan_comment_post_refs=${orphanCommentRefs.length}`)
    console.log(`duplicate_abs_chat_mid=${duplicateByAbsChatMid.length}`)
    if (orphanCommentRefs.length > 0) {
      console.log('orphan comment refs (top 20):')
      for (const row of orphanCommentRefs.slice(0, 20)) {
        console.log(`- post_id=${row.post_id}, comments=${row.cnt}`)
      }
    }

    const list = [...candidates.values()].sort((a, b) => b.signals - a.signals)
    printHeader('Кандидаты на "Обновить кнопки"')
    if (list.length === 0) {
      console.log('Кандидаты не найдены.')
      return
    }
    for (const c of list) {
      const reasons = [...c.reasons].sort().join(',')
      console.log(
        `- post_id=${c.postId ?? 'unknown'}; chat_id=${c.chatId ?? 'unknown'}; message_mid=${c.messageMid ?? 'unknown'}; reasons=${reasons}; signals=${c.signals}`,
      )
    }

    printHeader('Рекомендация')
    console.log('Запустите "Обновить кнопки" в админке для chat_id из списка выше.')
  } finally {
    db.close()
  }
}

void main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
