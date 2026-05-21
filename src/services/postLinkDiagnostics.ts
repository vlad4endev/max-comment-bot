import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

import { getDb } from '../db/database'

interface RuntimeLogEntry {
  ts?: string
  message?: string
  extra?: Record<string, unknown>
}

type CandidateReason =
  | 'log:id_mismatch'
  | 'log:post_lookup_not_found'
  | 'db:duplicate_abs_chat_mid'

export interface PostLinkCandidate {
  post_id?: string
  chat_id?: number
  message_mid?: string
  reasons: CandidateReason[]
  signals: number
}

export interface PostLinkDiagnosis {
  signals_total: number
  id_mismatch: number
  post_lookup_not_found: number
  orphan_comment_post_refs: number
  duplicate_abs_chat_mid: number
  candidates: PostLinkCandidate[]
}

const DEFAULT_RUNTIME_LOG_PATH = path.join(process.cwd(), 'data', 'runtime.log')
const MAX_SIGNAL_CANDIDATES = 100
const LOG_TAIL_BYTES = 5 * 1024 * 1024

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return null
  }
  return v as Record<string, unknown>
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

function asNonEmptyString(v: unknown): string | undefined {
  if (typeof v !== 'string') {
    return undefined
  }
  const t = v.trim()
  return t === '' ? undefined : t
}

function candidateKey(postId?: string, chatId?: number, messageMid?: string): string {
  return `${postId ?? '?'}|${chatId ?? '?'}|${messageMid ?? '?'}`
}

function upsertCandidate(
  map: Map<string, { post_id?: string; chat_id?: number; message_mid?: string; reasons: Set<CandidateReason>; signals: number }>,
  data: { post_id?: string; chat_id?: number; message_mid?: string; reason: CandidateReason },
): void {
  const key = candidateKey(data.post_id, data.chat_id, data.message_mid)
  const existing = map.get(key)
  if (existing) {
    existing.reasons.add(data.reason)
    existing.signals += 1
    return
  }
  map.set(key, {
    post_id: data.post_id,
    chat_id: data.chat_id,
    message_mid: data.message_mid,
    reasons: new Set([data.reason]),
    signals: 1,
  })
}

function sameAbsChat(a: number | undefined, b: number): boolean {
  return a !== undefined && Math.abs(a) === Math.abs(b)
}

function resolvePostByChatAndMid(chatId: number, messageMid: string): { post_id: string; chat_id: number; message_mid: string } | null {
  const row = getDb().prepare(
    `SELECT post_id, chat_id, message_mid
     FROM posts
     WHERE ABS(chat_id) = ABS(?) AND message_mid = ?
     ORDER BY timestamp DESC, post_id DESC
     LIMIT 1`,
  ).get(chatId, messageMid) as { post_id: string; chat_id: number; message_mid: string } | undefined
  return row ?? null
}

async function parseSignalCandidates(
  chatIdFilter?: number,
  runtimeLogPath: string = DEFAULT_RUNTIME_LOG_PATH,
): Promise<{
  idMismatch: number
  notFound: number
  candidates: Array<{ post_id?: string; chat_id?: number; message_mid?: string; reason: CandidateReason }>
}> {
  if (!fs.existsSync(runtimeLogPath)) {
    return { idMismatch: 0, notFound: 0, candidates: [] }
  }

  const size = fs.statSync(runtimeLogPath).size
  const start = Math.max(0, size - LOG_TAIL_BYTES)
  const stream = fs.createReadStream(runtimeLogPath, { encoding: 'utf8', start })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  const out: Array<{ post_id?: string; chat_id?: number; message_mid?: string; reason: CandidateReason }> = []
  let idMismatch = 0
  let notFound = 0
  let skipFirstPartialLine = start > 0

  for await (const lineRaw of rl) {
    if (skipFirstPartialLine) {
      skipFirstPartialLine = false
      continue
    }
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
    const message = asNonEmptyString(row?.message)
    const extra = asRecord(row?.extra)
    if (!message || !extra) {
      continue
    }

    if (message.includes('post_id в ссылке не совпадает')) {
      idMismatch += 1
      const chatId = asInt(extra.chatId)
      const messageMid = asNonEmptyString(extra.messageMid)
      const requestedPostId = asNonEmptyString(extra.requestedPostId)
      if (chatIdFilter !== undefined && !sameAbsChat(chatId, chatIdFilter)) {
        continue
      }
      if (chatId !== undefined && messageMid) {
        const fromDb = resolvePostByChatAndMid(chatId, messageMid)
        out.push({
          post_id: fromDb?.post_id ?? asNonEmptyString(extra.postId) ?? requestedPostId,
          chat_id: fromDb?.chat_id ?? chatId,
          message_mid: fromDb?.message_mid ?? messageMid,
          reason: 'log:id_mismatch',
        })
      } else {
        out.push({
          post_id: asNonEmptyString(extra.postId) ?? requestedPostId,
          chat_id: chatId,
          message_mid: messageMid,
          reason: 'log:id_mismatch',
        })
      }
      continue
    }

    if (message === 'miniapp: post lookup' && extra.found === false) {
      notFound += 1
      const chatId = asInt(extra.chatId)
      const messageMid = asNonEmptyString(extra.messageMid)
      const requestedPostId = asNonEmptyString(extra.receivedPostId ?? extra.identifier)
      if (chatIdFilter !== undefined && !sameAbsChat(chatId, chatIdFilter)) {
        continue
      }
      if (chatId !== undefined && messageMid) {
        const fromDb = resolvePostByChatAndMid(chatId, messageMid)
        out.push({
          post_id: fromDb?.post_id ?? requestedPostId,
          chat_id: fromDb?.chat_id ?? chatId,
          message_mid: fromDb?.message_mid ?? messageMid,
          reason: 'log:post_lookup_not_found',
        })
      } else {
        out.push({
          post_id: requestedPostId,
          chat_id: chatId,
          message_mid: messageMid,
          reason: 'log:post_lookup_not_found',
        })
      }
    }
  }

  return { idMismatch, notFound, candidates: out.slice(-MAX_SIGNAL_CANDIDATES) }
}

export async function diagnosePostLinks(chatIdFilter?: number): Promise<PostLinkDiagnosis> {
  const db = getDb()
  const orphanRow = db.prepare(
    `SELECT COUNT(*) AS n
     FROM comments c
     LEFT JOIN posts p ON p.post_id = c.post_id
     WHERE p.post_id IS NULL`,
  ).get() as { n: number }
  const duplicateRows = db.prepare(
    `SELECT ABS(chat_id) AS abs_chat_id, message_mid
     FROM posts
     GROUP BY ABS(chat_id), message_mid
     HAVING COUNT(*) > 1`,
  ).all() as Array<{ abs_chat_id: number; message_mid: string }>

  const parsed = await parseSignalCandidates(chatIdFilter)
  const candidates = new Map<
    string,
    { post_id?: string; chat_id?: number; message_mid?: string; reasons: Set<CandidateReason>; signals: number }
  >()

  for (const c of parsed.candidates) {
    upsertCandidate(candidates, {
      post_id: c.post_id,
      chat_id: c.chat_id,
      message_mid: c.message_mid,
      reason: c.reason,
    })
  }

  for (const dup of duplicateRows) {
    if (chatIdFilter !== undefined && Math.abs(dup.abs_chat_id) !== Math.abs(chatIdFilter)) {
      continue
    }
    upsertCandidate(candidates, {
      chat_id: dup.abs_chat_id,
      message_mid: dup.message_mid,
      reason: 'db:duplicate_abs_chat_mid',
    })
  }

  const candidateList: PostLinkCandidate[] = [...candidates.values()]
    .sort((a, b) => b.signals - a.signals)
    .map((c) => ({
      post_id: c.post_id,
      chat_id: c.chat_id,
      message_mid: c.message_mid,
      reasons: [...c.reasons].sort(),
      signals: c.signals,
    }))

  return {
    signals_total: parsed.idMismatch + parsed.notFound,
    id_mismatch: parsed.idMismatch,
    post_lookup_not_found: parsed.notFound,
    orphan_comment_post_refs: Number(orphanRow.n) || 0,
    duplicate_abs_chat_mid: duplicateRows.length,
    candidates: candidateList,
  }
}

