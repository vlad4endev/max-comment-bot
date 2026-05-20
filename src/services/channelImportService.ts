import axios from 'axios'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { getTelegramToken } from '../config'
import { getDb } from '../db/database'
import {
  getTelegramUpdatesWithIds,
  getTgFileUrl,
  type TgMessage,
} from '../forwarder/telegramReader'
import {
  sendDocumentFileToMax,
  sendDocumentToMax,
  sendMediaAlbumFilesToMax,
  sendPhotoFileToMax,
  sendPhotoToMax,
  sendTextToMax,
  sendVideoFileToMax,
  sendVideoToMax,
} from '../forwarder/maxPublisher'
import { logger } from '../utils/logger'
import {
  fetchChannelArchiveForImport,
  telegramUserArchiveConfigured,
} from './telegramUserArchive'
import {
  normalizeTelegramChannelKey,
  telegramChannelMatchesTarget,
} from '../utils/tgChannelMatch'

export const SCAN_IDLE_MAX = 5

const TG_API = 'https://api.telegram.org/bot'

export interface ChannelImportJobView extends ChannelImportJobRow {
  scan_idle_max: number
  status_hint: string | null
  can_publish: boolean
  reader_token_ok: boolean
  reader_uses_main_token: boolean
  user_archive_ready: boolean
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface ChannelImportJobRow {
  id: number
  tg_channel: string
  max_channel_id: string
  status: string
  import_source: string
  scan_next_offset: number
  scan_idle_rounds: number
  staged_count: number
  error_message: string | null
  created_at: string | null
  updated_at: string | null
}

export type StagedPayload =
  | { kind: 'text'; text: string }
  | { kind: 'photo'; caption: string; fileId?: string; localPath?: string }
  | { kind: 'video'; caption: string; fileId?: string; localPath?: string }
  | {
      kind: 'document'
      caption: string
      fileId?: string
      localPath?: string
      fileName?: string
      mimeType?: string
    }
  | {
      kind: 'album'
      caption: string
      items: (
        | { kind: 'photo'; localPath: string }
        | { kind: 'video'; localPath: string }
        | { kind: 'document'; localPath: string; fileName?: string; mimeType?: string }
      )[]
    }

export function resolveImportTgToken(): string {
  const reader = (process.env.TG_READER_BOT_TOKEN || '').trim()
  if (reader) return reader
  return getTelegramToken()
}

export function readerTokenMeta(): { ok: boolean; usesMainToken: boolean } {
  const reader = (process.env.TG_READER_BOT_TOKEN || '').trim()
  const fallback = getTelegramToken()
  if (reader) return { ok: true, usesMainToken: false }
  return { ok: fallback.length > 0, usesMainToken: fallback.length > 0 }
}

export async function assertTelegramPollingReady(tgToken: string): Promise<string | null> {
  if (!tgToken) {
    return 'Не задан TG_READER_BOT_TOKEN (или TG_TOKEN в интеграции)'
  }
  try {
    const { data } = await axios.get<{ ok: boolean; result?: { url?: string } }>(
      `${TG_API}${tgToken}/getWebhookInfo`,
      { timeout: 10_000 },
    )
    const url = data.result?.url?.trim()
    if (data.ok && url) {
      return `У бота включён webhook (${url}) — getUpdates пустой. Отключите webhook (deleteWebhook) для reader-бота.`
    }
  } catch {
    /* ignore probe errors */
  }
  return null
}

export function toChannelImportJobView(job: ChannelImportJobRow): ChannelImportJobView {
  const tokenMeta = readerTokenMeta()
  const staged = job.staged_count ?? 0
  let statusHint: string | null = null
  if (job.status === 'archive_fetch') {
    statusHint =
      staged > 0
        ? `Загрузка архива… подготовлено постов: ${staged}`
        : 'Загрузка архива канала через user-аккаунт (MTProto)…'
  } else if (job.status === 'scanning') {
    const step = Math.min(job.scan_idle_rounds + 1, SCAN_IDLE_MAX)
    statusHint = `Опрос Telegram ${step}/${SCAN_IDLE_MAX}… Найдено постов: ${staged}. Если долго 0 — в канале нет новых постов в очереди бота.`
  } else if (job.status === 'ready' && staged === 0) {
    statusHint =
      job.import_source === 'user_archive'
        ? 'Архив не дал постов: нет доступа user-аккаунта к каналу или сообщения без текста/медиа.'
        : 'В очереди обновлений бота нет постов этого канала. Опубликуйте новый пост в TG или проверьте, что reader-бот — админ в канале.'
  } else if (job.status === 'ready' && staged > 0) {
    statusHint = 'Можно публиковать в MAX.'
  }

  return {
    ...job,
    scan_idle_max: SCAN_IDLE_MAX,
    status_hint: job.error_message ?? statusHint,
    can_publish: job.status === 'ready' && staged > 0,
    reader_token_ok: tokenMeta.ok,
    reader_uses_main_token: tokenMeta.usesMainToken,
    user_archive_ready: telegramUserArchiveConfigured(),
  }
}

export function getActiveChannelImportJob(): ChannelImportJobView | undefined {
  const job = getDb()
    .prepare(
      `SELECT * FROM channel_import_jobs
       WHERE status IN ('scanning', 'archive_fetch', 'ready')
       ORDER BY id DESC LIMIT 1`,
    )
    .get() as ChannelImportJobRow | undefined
  return job ? toChannelImportJobView(job) : undefined
}

function getImportReaderOffset(): number {
  const row = getDb()
    .prepare('SELECT scan_next_offset FROM channel_import_reader_state WHERE id = 1')
    .get() as { scan_next_offset: number } | undefined
  return row?.scan_next_offset ?? 0
}

function setImportReaderOffset(offset: number): void {
  getDb()
    .prepare('UPDATE channel_import_reader_state SET scan_next_offset = ? WHERE id = 1')
    .run(offset)
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

export function createChannelImportJob(
  tgChannel: string,
  maxChannelId: string,
  options?: { archive?: boolean; archiveLimit?: number },
): number {
  const tg = normalizeTelegramChannelKey(tgChannel)
  const max = maxChannelId.trim()
  if (!tg || !max) {
    throw new Error('tg_channel and max_channel_id required')
  }
  const dup = getDb()
    .prepare(
      `SELECT id FROM channel_import_jobs
       WHERE tg_channel = ? AND max_channel_id = ? AND status IN ('scanning', 'archive_fetch', 'ready')`,
    )
    .get(tg, max) as { id: number } | undefined
  if (dup) {
    throw new Error('Уже есть активная задача импорта для этой пары TG → MAX')
  }
  const useArchive = options?.archive === true
  if (useArchive && !telegramUserArchiveConfigured()) {
    throw new Error(
      'Архив недоступен: настройте MTProto в блоке ниже (api_id, api_hash и вход по телефону)',
    )
  }
  const initialStatus = useArchive ? 'archive_fetch' : 'scanning'
  const r = getDb()
    .prepare(
      'INSERT INTO channel_import_jobs (tg_channel, max_channel_id, status, import_source) VALUES (?, ?, ?, ?)',
    )
    .run(tg, max, initialStatus, useArchive ? 'user_archive' : 'bot_queue')
  const jobId = Number(r.lastInsertRowid)
  if (useArchive) {
    const limit = Math.min(Math.max(options?.archiveLimit ?? 100, 1), 500)
    void runArchiveImportJob(jobId, limit).catch((err: unknown) => {
      logger.error('[channelImport] archive job failed job=' + String(jobId), err)
    })
  }
  return jobId
}

export async function runArchiveImportJob(jobId: number, limit: number): Promise<void> {
  const job = getChannelImportJob(jobId)
  if (!job || job.status !== 'archive_fetch') {
    return
  }
  try {
    const insertStmt = getDb().prepare(
      'INSERT OR IGNORE INTO channel_import_staged (job_id, tg_message_id, payload) VALUES (?, ?, ?)',
    )
    const bumpProgress = getDb().prepare(
      `UPDATE channel_import_jobs
       SET staged_count = ?, updated_at = datetime('now')
       WHERE id = ? AND status = 'archive_fetch'`,
    )

    const stagedCount = await fetchChannelArchiveForImport(
      job.tg_channel,
      limit,
      jobId,
      async (post) => {
        insertStmt.run(jobId, post.messageId, JSON.stringify(post.payload))
        const row = getDb()
          .prepare('SELECT COUNT(*) AS c FROM channel_import_staged WHERE job_id = ?')
          .get(jobId) as { c: number }
        bumpProgress.run(row?.c ?? 0, jobId)
      },
    )

    getDb()
      .prepare(
        `UPDATE channel_import_jobs
         SET status = 'ready', staged_count = ?, scan_idle_rounds = 0, error_message = NULL, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(stagedCount, jobId)
    logger.info('[channelImport] archive ready', { jobId, stagedCount })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    getDb()
      .prepare(
        `UPDATE channel_import_jobs SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(msg, jobId)
    throw err
  }
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

function updateJobAfterBatch(job: ChannelImportJobRow, jobGotPosts: boolean): void {
  const idle = jobGotPosts ? 0 : job.scan_idle_rounds + 1
  const stagedRow = getDb()
    .prepare('SELECT COUNT(*) AS c FROM channel_import_staged WHERE job_id = ?')
    .get(job.id) as { c: number }
  const stagedCount = stagedRow?.c ?? 0

  const nextStatus = idle >= SCAN_IDLE_MAX ? 'ready' : 'scanning'
  getDb()
    .prepare(
      `UPDATE channel_import_jobs
       SET scan_idle_rounds = ?, staged_count = ?, status = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(idle, stagedCount, nextStatus, job.id)
}

async function ingestScanBatchForJobs(
  jobs: ChannelImportJobRow[],
  tgToken: string,
): Promise<void> {
  const offset = getImportReaderOffset()
  const batch = await getTelegramUpdatesWithIds(tgToken, offset, 0)
  let nextOffset = offset
  const jobTouched = new Set<number>()

  for (const u of batch) {
    nextOffset = Math.max(nextOffset, u.update_id + 1)
    const msg = u.channel_post
    if (!msg) continue

    for (const job of jobs) {
      if (!telegramChannelMatchesTarget(msg.chat, job.tg_channel)) {
        continue
      }
      const payload = buildStagingPayload(msg)
      if (!payload) {
        continue
      }
      const ins = getDb()
        .prepare(
          'INSERT OR IGNORE INTO channel_import_staged (job_id, tg_message_id, payload) VALUES (?, ?, ?)',
        )
        .run(job.id, msg.message_id, JSON.stringify(payload))
      if (ins.changes > 0) {
        jobTouched.add(job.id)
      }
    }
  }

  if (nextOffset > offset) {
    setImportReaderOffset(nextOffset)
  }

  for (const job of jobs) {
    const fresh = getChannelImportJob(job.id)
    if (!fresh) continue
    updateJobAfterBatch(fresh, jobTouched.has(job.id))
  }
}

export async function tickChannelImportJobs(): Promise<void> {
  const tgToken = resolveImportTgToken()
  const jobs = getDb()
    .prepare("SELECT * FROM channel_import_jobs WHERE status = 'scanning'")
    .all() as ChannelImportJobRow[]

  if (jobs.length === 0) {
    return
  }

  const configErr = await assertTelegramPollingReady(tgToken)
  if (configErr) {
    for (const j of jobs) {
      getDb()
        .prepare(
          `UPDATE channel_import_jobs SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?`,
        )
        .run(configErr, j.id)
    }
    return
  }

  try {
    await ingestScanBatchForJobs(jobs, tgToken)
    logger.info('[channelImport] tick', {
      jobs: jobs.length,
      jobIds: jobs.map((j) => j.id),
    })
  } catch (err: unknown) {
    logger.error('[channelImport] scan batch failed', err)
    const msg = err instanceof Error ? err.message : String(err)
    for (const job of jobs) {
      getDb()
        .prepare(
          `UPDATE channel_import_jobs SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?`,
        )
        .run(msg, job.id)
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
      if (p.localPath) {
        await sendPhotoFileToMax(maxToken, maxChannelId, p.localPath, p.caption)
        return
      }
      if (!p.fileId) throw new Error('Фото: нет fileId')
      const url = await getTgFileUrl(tgToken, p.fileId)
      if (!url) {
        throw new Error('Фото: не удалось получить файл из Telegram')
      }
      await sendPhotoToMax(maxToken, maxChannelId, url, p.caption)
      return
    }
    case 'video': {
      if (p.localPath) {
        await sendVideoFileToMax(maxToken, maxChannelId, p.localPath, p.caption)
        return
      }
      if (!p.fileId) throw new Error('Видео: нет fileId')
      const url = await getTgFileUrl(tgToken, p.fileId)
      if (!url) {
        throw new Error('Видео: не удалось получить файл из Telegram')
      }
      await sendVideoToMax(maxToken, maxChannelId, url, p.caption)
      return
    }
    case 'document': {
      if (p.localPath) {
        await sendDocumentFileToMax(maxToken, maxChannelId, p.localPath, p.caption, {
          filename: p.fileName,
          contentType: p.mimeType,
        })
        return
      }
      if (!p.fileId) throw new Error('Документ: нет fileId')
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
    case 'album': {
      if (!p.items.length) {
        throw new Error('Альбом: пустой список медиа')
      }
      await sendMediaAlbumFilesToMax(
        maxToken,
        maxChannelId,
        p.caption,
        p.items.map((item) => ({
          type: item.kind === 'photo' ? 'image' : item.kind === 'video' ? 'video' : 'file',
          filePath: item.localPath,
          filename: item.kind === 'document' ? item.fileName : undefined,
          contentType: item.kind === 'document' ? item.mimeType : undefined,
        })),
      )
      return
    }
  }
}

function payloadLocalPaths(payload: StagedPayload): string[] {
  if (payload.kind === 'album') {
    return payload.items.map((item) => item.localPath).filter(Boolean)
  }
  if ('localPath' in payload && payload.localPath) {
    return [payload.localPath]
  }
  return []
}

async function cleanupImportTempDirectory(jobId: number): Promise<void> {
  const tmpDir = path.join(os.tmpdir(), 'maxcomment-import', String(jobId))
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
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

  const maxDest = job.max_channel_id.trim()
  if (!maxDest) {
    throw new Error('MAX-канал не задан')
  }

  try {
    for (const row of rows) {
      const p = JSON.parse(row.payload) as StagedPayload
      logger.info('[channelImport] Публикую пост в MAX', {
        jobId,
        stagedId: row.id,
        tgMessageId: row.tg_message_id,
        payloadKind: p.kind,
      })
      let published = false
      try {
        await publishStagedPayload(p, tgToken, maxToken, maxDest)
        published = true
      } finally {
        if (published) {
          const localPaths = payloadLocalPaths(p)
          for (const localPath of localPaths) {
            await fs.rm(localPath, { force: true }).catch(() => {})
          }
        }
      }
      logger.info('[channelImport] Пост опубликован, жду перед следующим', {
        jobId,
        stagedId: row.id,
        delayMs: 1500,
      })
      await sleep(1500 + Math.random() * 500)
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
  await cleanupImportTempDirectory(jobId)
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
  }, 2000)
}
