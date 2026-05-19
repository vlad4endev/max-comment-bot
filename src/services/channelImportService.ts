import { getDb } from '../db/database'
import {
  getTelegramUpdatesWithIds,
  getTgFileUrl,
  type TgMessage,
} from '../forwarder/telegramReader'
import {
  sendDocumentToMax,
  sendPhotoToMax,
  sendTextToMax,
  sendVideoToMax,
} from '../forwarder/maxPublisher'
import { logger } from '../utils/logger'

const SCAN_IDLE_MAX = 12

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface ChannelImportJobRow {
  id: number
  tg_channel: string
  max_channel_id: string
  status: string
  scan_next_offset: number
  scan_idle_rounds: number
  staged_count: number
  error_message: string | null
  created_at: string | null
  updated_at: string | null
}

export type StagedPayload =
  | { kind: 'text'; text: string }
  | { kind: 'photo'; caption: string; fileId: string }
  | { kind: 'video'; caption: string; fileId: string }
  | { kind: 'document'; caption: string; fileId: string; fileName?: string; mimeType?: string }

function normalizeTgChannel(raw: string): string {
  const t = raw.trim()
  if (t === '') return t
  return t.startsWith('@') ? t : `@${t}`
}

function matchesChannel(msg: TgMessage, configTgChannel: string): boolean {
  const u = msg.chat.username?.trim()
  const chatUsername = u ? `@${u}` : String(msg.chat.id)
  const normalized = configTgChannel.startsWith('@') ? configTgChannel : `@${configTgChannel}`
  return chatUsername === normalized || String(msg.chat.id) === configTgChannel.trim()
}

function buildStagingPayload(msg: TgMessage): StagedPayload | null {
  const caption = (msg.caption || msg.text || '').trim()
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1]
    return { kind: 'photo', caption, fileId: largest.file_id }
  }
  if (msg.video?.file_id) {
    return { kind: 'video', caption, fileId: msg.video.file_id }
  }
  if (msg.document?.file_id) {
    return {
      kind: 'document',
      caption,
      fileId: msg.document.file_id,
      fileName: msg.document.file_name,
      mimeType: msg.document.mime_type,
    }
  }
  if (caption) {
    return { kind: 'text', text: caption }
  }
  return null
}

export function createChannelImportJob(tgChannel: string, maxChannelId: string): number {
  const tg = normalizeTgChannel(tgChannel)
  const max = maxChannelId.trim()
  if (!tg || !max) {
    throw new Error('tg_channel and max_channel_id required')
  }
  const r = getDb()
    .prepare('INSERT INTO channel_import_jobs (tg_channel, max_channel_id) VALUES (?, ?)')
    .run(tg, max)
  return Number(r.lastInsertRowid)
}

export function getChannelImportJob(id: number): ChannelImportJobRow | undefined {
  return getDb()
    .prepare('SELECT * FROM channel_import_jobs WHERE id = ?')
    .get(id) as ChannelImportJobRow | undefined
}

export function cancelChannelImportJob(id: number): boolean {
  const r = getDb().prepare('DELETE FROM channel_import_jobs WHERE id = ?').run(id)
  return r.changes > 0
}

async function ingestScanBatch(job: ChannelImportJobRow, tgToken: string): Promise<void> {
  const batch = await getTelegramUpdatesWithIds(tgToken, job.scan_next_offset, 0)
  let nextOffset = job.scan_next_offset
  for (const u of batch) {
    nextOffset = Math.max(nextOffset, u.update_id + 1)
    const msg = u.channel_post
    if (!matchesChannel(msg, job.tg_channel)) {
      continue
    }
    const payload = buildStagingPayload(msg)
    if (!payload) {
      continue
    }
    getDb()
      .prepare(
        'INSERT OR IGNORE INTO channel_import_staged (job_id, tg_message_id, payload) VALUES (?, ?, ?)',
      )
      .run(job.id, msg.message_id, JSON.stringify(payload))
  }

  const idle = batch.length === 0 ? job.scan_idle_rounds + 1 : 0
  const stagedRow = getDb()
    .prepare('SELECT COUNT(*) AS c FROM channel_import_staged WHERE job_id = ?')
    .get(job.id) as { c: number }
  const stagedCount = stagedRow?.c ?? 0

  if (idle >= SCAN_IDLE_MAX && stagedCount === 0) {
    getDb().prepare('DELETE FROM channel_import_jobs WHERE id = ?').run(job.id)
    return
  }

  const nextStatus = idle >= SCAN_IDLE_MAX ? 'ready' : 'scanning'
  getDb()
    .prepare(
      `UPDATE channel_import_jobs
       SET scan_next_offset = ?, scan_idle_rounds = ?, staged_count = ?, status = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(nextOffset, idle, stagedCount, nextStatus, job.id)
}

export async function tickChannelImportJobs(): Promise<void> {
  const tgToken = (process.env.TG_READER_BOT_TOKEN || '').trim()
  const jobs = getDb()
    .prepare("SELECT * FROM channel_import_jobs WHERE status = 'scanning'")
    .all() as ChannelImportJobRow[]

  if (jobs.length === 0) {
    return
  }

  if (!tgToken) {
    for (const j of jobs) {
      getDb()
        .prepare(
          `UPDATE channel_import_jobs SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?`,
        )
        .run('TG_READER_BOT_TOKEN не задан', j.id)
    }
    return
  }

  for (const job of jobs) {
    try {
      await ingestScanBatch(job, tgToken)
    } catch (err: unknown) {
      logger.error('[channelImport] scan batch failed job=' + String(job.id), err)
      getDb()
        .prepare(
          `UPDATE channel_import_jobs SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?`,
        )
        .run(err instanceof Error ? err.message : String(err), job.id)
    }
  }
}

async function publishStagedPayload(
  p: StagedPayload,
  tgToken: string,
  maxToken: string,
  maxChannelId: string,
): Promise<void> {
  switch (p.kind) {
    case 'text':
      await sendTextToMax(maxToken, maxChannelId, p.text)
      return
    case 'photo': {
      const url = await getTgFileUrl(tgToken, p.fileId)
      if (!url) {
        throw new Error('Фото: не удалось получить файл из Telegram')
      }
      await sendPhotoToMax(maxToken, maxChannelId, url, p.caption)
      return
    }
    case 'video': {
      const url = await getTgFileUrl(tgToken, p.fileId)
      if (!url) {
        throw new Error('Видео: не удалось получить файл из Telegram')
      }
      await sendVideoToMax(maxToken, maxChannelId, url, p.caption)
      return
    }
    case 'document': {
      const url = await getTgFileUrl(tgToken, p.fileId)
      if (!url) {
        throw new Error('Документ: не удалось получить файл из Telegram')
      }
      await sendDocumentToMax(maxToken, maxChannelId, url, p.caption, {
        filename: p.fileName,
        contentType: p.mimeType,
      })
      return
    }
  }
}

export async function publishChannelImportJob(
  jobId: number,
  tgToken: string,
  maxToken: string,
): Promise<void> {
  const job = getChannelImportJob(jobId)
  if (!job || job.status !== 'ready') {
    throw new Error('Импорт не готов к публикации (ожидайте статус ready)')
  }

  getDb()
    .prepare(
      `UPDATE channel_import_jobs SET status = 'publishing', error_message = NULL, updated_at = datetime('now') WHERE id = ?`,
    )
    .run(jobId)

  const rows = getDb()
    .prepare('SELECT * FROM channel_import_staged WHERE job_id = ? ORDER BY id ASC')
    .all(jobId) as { id: number; tg_message_id: number; payload: string }[]

  try {
    for (const row of rows) {
      const p = JSON.parse(row.payload) as StagedPayload
      await publishStagedPayload(p, tgToken, maxToken, job.max_channel_id)
      await sleep(1500 + Math.random() * 2000)
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    getDb()
      .prepare(
        `UPDATE channel_import_jobs SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(msg, jobId)
    throw err
  }

  getDb().prepare('DELETE FROM channel_import_staged WHERE job_id = ?').run(jobId)
  getDb().prepare('DELETE FROM channel_import_jobs WHERE id = ?').run(jobId)
}

let workerStarted = false

export function startChannelImportWorker(): void {
  if (workerStarted) {
    return
  }
  workerStarted = true
  setInterval(() => {
    void tickChannelImportJobs().catch((err: unknown) => {
      logger.error('[channelImport] tick', err)
    })
  }, 3000)
}
