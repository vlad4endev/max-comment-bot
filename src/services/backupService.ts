import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { getAntispamDb } from '../db/antispamDatabase'
import { getDb } from '../db/database'
import { getPostsDb } from '../db/postsDatabase'
import { channelNotifyLinkStore } from './channelNotifyLinkStore'
import { packDirectoryToTarGz } from '../utils/tarGz'
import { logger } from '../utils/logger'

const DATA_DIR = join(process.cwd(), 'data')
const BACKUPS_DIR = join(DATA_DIR, 'backups')
const MINIAPP_UPLOADS_DIR = join(process.cwd(), 'miniapp', 'uploads')
const ROOT_ENV_PATH = join(process.cwd(), '.env')
const CONFIG_ENV_PATH = join(process.cwd(), 'config', '.env')

const BACKUP_ID_RE = /^\d{4}-\d{2}-\d{2}_\d{6}(-\d+)?$/

const SQLITE_LIVE_NAMES = new Set([
  'bot.db',
  'bot.db-wal',
  'bot.db-shm',
  'posts.db',
  'posts.db-wal',
  'posts.db-shm',
  'antispam.db',
  'antispam.db-wal',
  'antispam.db-shm',
])

const SKIP_DATA_NAMES = new Set(['backups', ...SQLITE_LIVE_NAMES])

const CURATED_ENV_KEYS = [
  'BOT_TOKEN',
  'TG_TOKEN',
  'TELEGRAM_TOKEN',
  'TG_BOT_TOKEN',
  'TG_READER_BOT_TOKEN',
  'TG_ANTISPAM_BOT_TOKEN',
  'ADMIN_PANEL_USER',
  'ADMIN_PANEL_PASSWORD',
  'ADMIN_PANEL_SESSION_SECRET',
  'OWNER_USER_ID',
  'ADMIN_CHAT_ID',
  'BOT_NICKNAME',
  'NODE_ENV',
  'PORT',
  'API_PORT',
  'MAX_RECEIVE_MODE',
  'MINI_APP_URL',
  'WEBHOOK_URL',
  'WEBHOOK_SECRET',
  'FLOW_POLL_INTERVAL_MS',
  'REDIS_URL',
  'TG_API_ID',
  'TG_API_HASH',
  'TG_USER_SESSION',
] as const

export interface BackupFileEntry {
  path: string
  bytes: number
  kind: 'sqlite' | 'json' | 'env' | 'media' | 'other'
}

export interface BackupManifest {
  version: 1
  created_at: string
  app: string
  files: BackupFileEntry[]
  databases: {
    bot: boolean
    posts: boolean
    antispam: boolean
  }
  includes_env_file: boolean
  includes_runtime_env: boolean
  includes_uploads: boolean
  file_count: number
  uncompressed_bytes: number
}

export interface BackupRecord {
  id: string
  filename: string
  created_at: string
  size_bytes: number
  file_count: number
  databases: BackupManifest['databases']
  includes_env_file: boolean
  includes_runtime_env: boolean
  includes_uploads: boolean
}

export interface BackupSourceOverview {
  databases: Array<{ name: string; exists: boolean; size_bytes: number }>
  json_files: number
  media_files: number
  env_file: boolean
  uploads: boolean
  notes: string[]
}

export interface BackupListPayload {
  items: BackupRecord[]
  creating: boolean
  total_size_bytes: number
  source: BackupSourceOverview
}

let creatingLock: Promise<BackupRecord> | null = null

function isBackupId(id: string): boolean {
  return BACKUP_ID_RE.test(id)
}

function formatBackupId(date: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

function archiveFilename(id: string): string {
  return `max-comment-bot-backup-${id}.tar.gz`
}

function sidecarPath(id: string): string {
  return join(BACKUPS_DIR, `${id}.json`)
}

function archivePath(id: string): string {
  return join(BACKUPS_DIR, archiveFilename(id))
}

function classifyKind(relPath: string): BackupFileEntry['kind'] {
  const lower = relPath.toLowerCase()
  if (lower.endsWith('.db')) return 'sqlite'
  if (lower.endsWith('.json')) return 'json'
  if (lower.includes('/env/') || lower.endsWith('.env') || lower.endsWith('/dotenv')) return 'env'
  if (lower.includes('/autoposts-media/') || lower.includes('/uploads/')) return 'media'
  return 'other'
}

function isLogFile(name: string): boolean {
  return name === 'runtime.log' || name.startsWith('runtime.log.') || name.endsWith('.log')
}

function isTmpName(name: string): boolean {
  return name.startsWith('.tmp-') || name.endsWith('.tmp')
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

async function fileSizeOrZero(path: string): Promise<number> {
  try {
    const st = await stat(path)
    return st.isFile() ? st.size : 0
  } catch {
    return 0
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function countFiles(dir: string, predicate?: (name: string, isDir: boolean) => boolean): Promise<number> {
  if (!(await pathExists(dir))) return 0
  let count = 0
  async function walk(current: string): Promise<void> {
    const names = await readdir(current)
    for (const name of names) {
      const abs = join(current, name)
      const st = await stat(abs)
      if (predicate && !predicate(name, st.isDirectory())) continue
      if (st.isDirectory()) {
        await walk(abs)
      } else if (st.isFile()) {
        count += 1
      }
    }
  }
  await walk(dir)
  return count
}

async function copyTree(
  srcDir: string,
  destDir: string,
  shouldSkip: (name: string, relPosix: string, isDir: boolean) => boolean,
): Promise<void> {
  if (!(await pathExists(srcDir))) return
  await ensureDir(destDir)
  const names = await readdir(srcDir)
  for (const name of names) {
    const src = join(srcDir, name)
    const st = await stat(src)
    const relPosix = relative(srcDir, src).split(sep).join('/')
    if (shouldSkip(name, relPosix, st.isDirectory())) continue
    const dest = join(destDir, name)
    if (st.isDirectory()) {
      await copyTree(src, dest, shouldSkip)
    } else if (st.isFile()) {
      await ensureDir(dirname(dest))
      await copyFile(src, dest)
    }
  }
}

async function snapshotSqlite(
  db: { backup: (dest: string) => Promise<unknown>; pragma: (src: string) => unknown },
  destPath: string,
): Promise<boolean> {
  await ensureDir(dirname(destPath))
  try {
    db.pragma('wal_checkpoint(PASSIVE)')
  } catch {
    // WAL may be off — snapshot still works
  }
  await db.backup(destPath)
  return true
}

function formatEnvValue(value: string): string {
  if (/[\s#"'\\]/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return value
}

async function writeRuntimeEnv(destPath: string): Promise<{ written: boolean; keys: number }> {
  const lines = [
    '# Снимок переменных окружения на момент резервной копии.',
    '# В Docker файл .env часто не смонтирован — этот снимок нужен для восстановления.',
    '',
  ]
  let keys = 0
  for (const key of CURATED_ENV_KEYS) {
    const raw = process.env[key]
    if (raw === undefined || raw === '') continue
    lines.push(`${key}=${formatEnvValue(raw)}`)
    keys += 1
  }
  if (keys === 0) {
    return { written: false, keys: 0 }
  }
  await ensureDir(dirname(destPath))
  await writeFile(destPath, `${lines.join('\n')}\n`, 'utf8')
  return { written: true, keys }
}

function restoreReadme(): string {
  return [
    'Как восстановить CommentBot из этой копии',
    '==========================================',
    '',
    'Архив содержит базы SQLite, JSON-настройки, токены и медиа.',
    'Храните файл в безопасном месте: внутри секреты (токены ботов, пароль админки, сессия Telegram).',
    '',
    '1. Остановите бота (docker compose stop / systemctl stop / Ctrl+C).',
    '2. Распакуйте архив:',
    '     tar -xzf max-comment-bot-backup-….tar.gz',
    '3. Скопируйте папку data/ в каталог проекта, заменив текущую',
    '   (в Docker это том ./data → /app/data).',
    '4. Восстановите переменные окружения:',
    '     — если есть env/dotenv, скопируйте его в .env в корне проекта;',
    '     — иначе перенесите значения из env/settings.env в .env.',
    '5. Если есть miniapp/uploads/, скопируйте её рядом с miniapp/.',
    '6. Запустите бота заново (docker compose up -d или npm start).',
    '',
    'Журналы runtime.log в архив не входят — для работы бота они не нужны.',
    '',
  ].join('\n')
}

async function collectManifestFiles(stagingRoot: string): Promise<BackupFileEntry[]> {
  const files: BackupFileEntry[] = []

  async function walk(dir: string): Promise<void> {
    const names = await readdir(dir)
    for (const name of names) {
      const abs = join(dir, name)
      const st = await stat(abs)
      if (st.isDirectory()) {
        await walk(abs)
      } else if (st.isFile()) {
        const rel = relative(stagingRoot, abs).split(sep).join('/')
        files.push({ path: rel, bytes: st.size, kind: classifyKind(rel) })
      }
    }
  }

  await walk(stagingRoot)
  files.sort((a, b) => a.path.localeCompare(b.path))
  return files
}

async function uniqueBackupId(now: Date): Promise<string> {
  await ensureDir(BACKUPS_DIR)
  let id = formatBackupId(now)
  let n = 2
  while ((await pathExists(archivePath(id))) || (await pathExists(sidecarPath(id)))) {
    id = `${formatBackupId(now)}-${n}`
    n += 1
  }
  return id
}

function recordFromManifest(id: string, sizeBytes: number, manifest: BackupManifest): BackupRecord {
  return {
    id,
    filename: archiveFilename(id),
    created_at: manifest.created_at,
    size_bytes: sizeBytes,
    file_count: manifest.file_count,
    databases: manifest.databases,
    includes_env_file: manifest.includes_env_file,
    includes_runtime_env: manifest.includes_runtime_env,
    includes_uploads: manifest.includes_uploads,
  }
}

async function readSidecar(id: string): Promise<BackupRecord | null> {
  if (!isBackupId(id)) return null
  const archive = archivePath(id)
  if (!(await pathExists(archive))) return null
  const size = await fileSizeOrZero(archive)
  try {
    const raw = await readFile(sidecarPath(id), 'utf8')
    const parsed = JSON.parse(raw) as BackupRecord
    if (parsed && typeof parsed.id === 'string') {
      return { ...parsed, size_bytes: size, filename: archiveFilename(id) }
    }
  } catch {
    // sidecar missing/corrupt — still list the archive
  }
  const st = await stat(archive)
  return {
    id,
    filename: archiveFilename(id),
    created_at: st.mtime.toISOString(),
    size_bytes: size,
    file_count: 0,
    databases: { bot: false, posts: false, antispam: false },
    includes_env_file: false,
    includes_runtime_env: false,
    includes_uploads: false,
  }
}

export function isBackupCreateInProgress(): boolean {
  return creatingLock !== null
}

export async function getBackupSourceOverview(): Promise<BackupSourceOverview> {
  const dbNames = ['bot.db', 'posts.db', 'antispam.db'] as const
  const databases = await Promise.all(
    dbNames.map(async (name) => ({
      name,
      exists: await pathExists(join(DATA_DIR, name)),
      size_bytes: await fileSizeOrZero(join(DATA_DIR, name)),
    })),
  )

  let jsonFiles = 0
  let mediaFiles = 0
  if (await pathExists(DATA_DIR)) {
    jsonFiles = await countFiles(DATA_DIR, (name, isDir) => {
      if (isDir) return name !== 'backups' && !name.startsWith('.tmp-')
      return name.endsWith('.json')
    })
    mediaFiles = await countFiles(join(DATA_DIR, 'autoposts-media'))
  }
  const uploads = (await countFiles(MINIAPP_UPLOADS_DIR)) > 0

  return {
    databases,
    json_files: jsonFiles,
    media_files: mediaFiles,
    env_file: existsSync(ROOT_ENV_PATH) || existsSync(CONFIG_ENV_PATH),
    uploads,
    notes: [
      'В архив входят базы SQLite, все JSON-настройки, токены, медиа автопостинга и загрузки Mini App.',
      'Журналы runtime.log не включаются — они не нужны для восстановления.',
      'Архив содержит секреты. Храните его только в надёжном месте.',
    ],
  }
}

export async function listBackups(): Promise<BackupRecord[]> {
  await ensureDir(BACKUPS_DIR)
  const names = await readdir(BACKUPS_DIR)
  const ids = names
    .filter((n) => n.startsWith('max-comment-bot-backup-') && n.endsWith('.tar.gz'))
    .map((n) => n.slice('max-comment-bot-backup-'.length, -'.tar.gz'.length))
    .filter(isBackupId)
  const items: BackupRecord[] = []
  for (const id of ids) {
    const rec = await readSidecar(id)
    if (rec) items.push(rec)
  }
  items.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
  return items
}

export async function getBackupListPayload(): Promise<BackupListPayload> {
  const items = await listBackups()
  return {
    items,
    creating: isBackupCreateInProgress(),
    total_size_bytes: items.reduce((sum, it) => sum + it.size_bytes, 0),
    source: await getBackupSourceOverview(),
  }
}

export async function getBackupFile(id: string): Promise<{
  id: string
  filename: string
  absPath: string
  size_bytes: number
} | null> {
  if (!isBackupId(id)) return null
  const absPath = resolve(archivePath(id))
  const root = resolve(BACKUPS_DIR)
  if (!absPath.startsWith(root + sep) && absPath !== root) return null
  if (!(await pathExists(absPath))) return null
  return {
    id,
    filename: archiveFilename(id),
    absPath,
    size_bytes: await fileSizeOrZero(absPath),
  }
}

export async function deleteBackup(id: string): Promise<boolean> {
  if (!isBackupId(id)) return false
  const file = await getBackupFile(id)
  if (!file) return false
  await rm(file.absPath, { force: true })
  await rm(sidecarPath(id), { force: true })
  logger.info('backup: deleted', { id })
  return true
}

async function createBackupInternal(): Promise<BackupRecord> {
  const createdAt = new Date()
  const id = await uniqueBackupId(createdAt)
  const staging = join(BACKUPS_DIR, `.tmp-${id}`)
  await rm(staging, { recursive: true, force: true })
  await ensureDir(staging)

  try {
    try {
      await channelNotifyLinkStore.forcePersist()
    } catch {
      // store may not be loaded yet
    }

    const dataStaging = join(staging, 'data')
    await ensureDir(dataStaging)

    const databases = { bot: false, posts: false, antispam: false }
    databases.bot = await snapshotSqlite(getDb(), join(dataStaging, 'bot.db'))
    databases.posts = await snapshotSqlite(getPostsDb(), join(dataStaging, 'posts.db'))
    databases.antispam = await snapshotSqlite(getAntispamDb(), join(dataStaging, 'antispam.db'))

    await copyTree(DATA_DIR, dataStaging, (name, _rel, isDir) => {
      if (isDir && name === 'backups') return true
      if (isTmpName(name)) return true
      if (SKIP_DATA_NAMES.has(name)) return true
      if (isLogFile(name)) return true
      return false
    })

    const envDir = join(staging, 'env')
    await ensureDir(envDir)
    let includesEnvFile = false
    if (existsSync(ROOT_ENV_PATH)) {
      await copyFile(ROOT_ENV_PATH, join(envDir, 'dotenv'))
      includesEnvFile = true
    }
    if (existsSync(CONFIG_ENV_PATH)) {
      await copyFile(CONFIG_ENV_PATH, join(envDir, 'config.env'))
      includesEnvFile = true
    }
    const runtimeEnv = await writeRuntimeEnv(join(envDir, 'settings.env'))

    let includesUploads = false
    if (await pathExists(MINIAPP_UPLOADS_DIR)) {
      const uploadCount = await countFiles(MINIAPP_UPLOADS_DIR)
      if (uploadCount > 0) {
        await copyTree(MINIAPP_UPLOADS_DIR, join(staging, 'miniapp', 'uploads'), (name) => isTmpName(name))
        includesUploads = true
      }
    }

    await writeFile(join(staging, 'RESTORE.txt'), restoreReadme(), 'utf8')

    const files = await collectManifestFiles(staging)
    const uncompressed = files.reduce((sum, f) => sum + f.bytes, 0)
    const manifest: BackupManifest = {
      version: 1,
      created_at: createdAt.toISOString(),
      app: 'max-comment-bot',
      files,
      databases,
      includes_env_file: includesEnvFile,
      includes_runtime_env: runtimeEnv.written,
      includes_uploads: includesUploads,
      file_count: files.length,
      uncompressed_bytes: uncompressed,
    }
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    const dest = archivePath(id)
    await packDirectoryToTarGz(staging, dest)
    const sizeBytes = await fileSizeOrZero(dest)
    const record = recordFromManifest(id, sizeBytes, {
      ...manifest,
      file_count: files.length + 1,
    })
    await writeFile(sidecarPath(id), `${JSON.stringify(record, null, 2)}\n`, 'utf8')

    logger.info('backup: created', {
      id,
      sizeBytes,
      fileCount: record.file_count,
      databases,
    })
    return record
  } catch (err) {
    await rm(archivePath(id), { force: true })
    await rm(sidecarPath(id), { force: true })
    logger.error('backup: create failed', { id, err })
    throw err
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

export async function createBackup(): Promise<BackupRecord> {
  if (creatingLock) {
    throw new BackupBusyError()
  }
  const job = createBackupInternal()
  creatingLock = job
  try {
    return await job
  } finally {
    creatingLock = null
  }
}

export class BackupBusyError extends Error {
  constructor() {
    super('Резервная копия уже создаётся')
    this.name = 'BackupBusyError'
  }
}
