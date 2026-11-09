/**
 * Распаковка архива и подмена файлов при восстановлении резервной копии.
 * Живой прогон пишет в data/ и удаляет только то, чего не было до старта.
 */
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dataDir = path.resolve(__dirname, '../data')
const before = new Set(fs.readdirSync(dataDir))

function cleanupNewDataFiles(): void {
  for (const name of fs.readdirSync(dataDir)) {
    if (before.has(name)) continue
    fs.rmSync(path.join(dataDir, name), { recursive: true, force: true })
  }
}

function octalField(value: number, length: number): Buffer {
  const body = value.toString(8).padStart(length - 1, '0')
  const buf = Buffer.alloc(length, 0)
  buf.write(body, 0, length - 1, 'utf8')
  return buf
}

function rawTar(entries: Array<{ name: string; body?: Buffer; type?: 'file' | 'symlink' }>): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const header = Buffer.alloc(512, 0)
    header.write(entry.name, 0, 'utf8')
    octalField(0o644, 8).copy(header, 100)
    const body = entry.body ?? Buffer.alloc(0)
    octalField(entry.type === 'symlink' ? 0 : body.length, 12).copy(header, 124)
    octalField(Math.floor(Date.now() / 1000), 12).copy(header, 136)
    header.fill(0x20, 148, 156)
    header[156] = entry.type === 'symlink' ? 0x32 : 0x30
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    let sum = 0
    for (let i = 0; i < 512; i += 1) sum += header[i] ?? 0
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    blocks.push(header)
    if (entry.type !== 'symlink' && body.length > 0) {
      blocks.push(body)
      const pad = (512 - (body.length % 512)) % 512
      if (pad) blocks.push(Buffer.alloc(pad))
    }
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

function sqliteStub(): Buffer {
  const buf = Buffer.alloc(32)
  buf.write('SQLite format 3\0', 0, 'utf8')
  return buf
}

async function main(): Promise<void> {
  process.env.NODE_ENV = 'development'
  process.env.MAX_RECEIVE_MODE = 'polling'
  process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'test-backup-token'
  process.env.ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '1'
  process.env.BOT_NICKNAME = process.env.BOT_NICKNAME || 'testbot'

  const { extractTarGz, TarExtractError, packDirectoryToTarGz } = await import('../src/utils/tarGz')
  const { applyExtractedBackup, BackupArchiveError, createBackup, restoreBackup, importUploadedBackup } =
    await import('../src/services/backupService')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-restore-'))
  const outside = path.join(root, 'outside.txt')
  const evilArchive = path.join(root, 'evil.tar.gz')
  fs.writeFileSync(evilArchive, gzipSync(rawTar([{ name: '../outside.txt', body: Buffer.from('pwned') }])))
  await assert.rejects(() => extractTarGz(evilArchive, path.join(root, 'evil-out')), TarExtractError)
  assert.equal(fs.existsSync(outside), false)

  const linkArchive = path.join(root, 'link.tar.gz')
  fs.writeFileSync(linkArchive, gzipSync(rawTar([{ name: 'data/link', type: 'symlink' }])))
  await assert.rejects(() => extractTarGz(linkArchive, path.join(root, 'link-out')), /ссылка|неподдерживаемый/)

  const staging = path.join(root, 'staging')
  fs.mkdirSync(path.join(staging, 'data', 'backups'), { recursive: true })
  fs.writeFileSync(path.join(staging, 'data', 'backups', 'secret.txt'), 'nope')
  fs.writeFileSync(path.join(staging, 'data', 'bot.db'), sqliteStub())
  fs.writeFileSync(path.join(staging, 'data', 'posts.db'), sqliteStub())
  fs.writeFileSync(path.join(staging, 'data', 'antispam.db'), sqliteStub())
  fs.writeFileSync(path.join(staging, 'data', 'keep.json'), '{"ok":true}\n')
  fs.mkdirSync(path.join(staging, 'env'), { recursive: true })
  fs.writeFileSync(path.join(staging, 'env', 'dotenv'), 'BOT_TOKEN=restored\n')
  fs.writeFileSync(
    path.join(staging, 'manifest.json'),
    JSON.stringify({
      version: 1,
      created_at: new Date().toISOString(),
      app: 'max-comment-bot',
      files: [],
      databases: { bot: true, posts: true, antispam: true },
      includes_env_file: true,
      includes_runtime_env: false,
      includes_uploads: false,
      file_count: 1,
      uncompressed_bytes: 1,
    }),
  )

  const packed = path.join(root, 'good.tar.gz')
  const extracted = path.join(root, 'extracted')
  await packDirectoryToTarGz(staging, packed)
  const packedInfo = await extractTarGz(packed, extracted)
  assert.ok(packedInfo.files >= 4)
  assert.equal(fs.readFileSync(path.join(extracted, 'data', 'keep.json'), 'utf8'), '{"ok":true}\n')

  const targetData = path.join(root, 'target', 'data')
  const targetUploads = path.join(root, 'target', 'uploads')
  const targetEnv = path.join(root, 'target', '.env')
  const targetConfigEnv = path.join(root, 'target', 'config.env')
  fs.mkdirSync(path.join(targetData, 'backups'), { recursive: true })
  fs.writeFileSync(path.join(targetData, 'backups', 'keep.txt'), 'stay')
  fs.writeFileSync(path.join(targetData, 'stale.json'), '{"stale":true}\n')

  const applied = await applyExtractedBackup(
    extracted,
    {
      dataDir: targetData,
      uploadsDir: targetUploads,
      rootEnvPath: targetEnv,
      configEnvPath: targetConfigEnv,
    },
    { restoreEnv: false },
  )
  assert.equal(applied.restored_env, false)
  assert.equal(fs.existsSync(targetEnv), false)
  assert.equal(fs.readFileSync(path.join(targetData, 'keep.json'), 'utf8'), '{"ok":true}\n')
  assert.equal(fs.existsSync(path.join(targetData, 'stale.json')), false)
  assert.equal(fs.readFileSync(path.join(targetData, 'backups', 'keep.txt'), 'utf8'), 'stay')
  assert.equal(fs.existsSync(path.join(targetData, 'backups', 'secret.txt')), false)
  assert.ok(applied.removed_files >= 1)

  const withEnv = await applyExtractedBackup(
    extracted,
    {
      dataDir: targetData,
      uploadsDir: targetUploads,
      rootEnvPath: targetEnv,
      configEnvPath: targetConfigEnv,
    },
    { restoreEnv: true },
  )
  assert.equal(withEnv.restored_env, true)
  assert.equal(fs.readFileSync(targetEnv, 'utf8'), 'BOT_TOKEN=restored\n')

  const bad = path.join(root, 'bad-manifest')
  fs.mkdirSync(path.join(bad, 'data'), { recursive: true })
  fs.writeFileSync(path.join(bad, 'manifest.json'), JSON.stringify({ version: 1, app: 'other' }))
  await assert.rejects(() => applyExtractedBackup(bad, {
    dataDir: path.join(root, 'unused'),
    uploadsDir: path.join(root, 'unused-uploads'),
    rootEnvPath: path.join(root, 'unused.env'),
    configEnvPath: path.join(root, 'unused-config.env'),
  }, { restoreEnv: false }), BackupArchiveError)

  const { getDb, closeDb } = await import('../src/db/database')
  getDb().exec('CREATE TABLE IF NOT EXISTS restore_probe (v TEXT)')
  getDb().prepare('DELETE FROM restore_probe').run()
  getDb().prepare(`INSERT INTO restore_probe (v) VALUES ('original')`).run()
  fs.writeFileSync(path.join(dataDir, 'restore-probe.json'), '{"value":"original"}\n')

  const backup = await createBackup()
  getDb().prepare(`UPDATE restore_probe SET v = 'changed'`).run()
  fs.writeFileSync(path.join(dataDir, 'restore-probe.json'), '{"value":"changed"}\n')

  const badUpload = path.join(root, 'not-a-backup.tar.gz')
  fs.writeFileSync(badUpload, gzipSync(Buffer.from('hello')))
  await assert.rejects(() => importUploadedBackup(badUpload, { restore: true, restoreEnv: false }), BackupArchiveError)
  assert.equal(
    (getDb().prepare('SELECT v FROM restore_probe').get() as { v: string }).v,
    'changed',
  )

  const restored = await restoreBackup(backup.id, { restoreEnv: false })
  assert.equal(restored.ok, true)
  assert.equal(restored.restored_env, false)
  assert.ok(restored.safety_backup_id)
  assert.equal(
    (getDb().prepare('SELECT v FROM restore_probe').get() as { v: string }).v,
    'original',
  )
  assert.equal(fs.readFileSync(path.join(dataDir, 'restore-probe.json'), 'utf8'), '{"value":"original"}\n')

  const http = await import('node:http')
  const express = (await import('express')).default
  const { createAdminRouter } = await import('../src/api/adminRoutes')
  const { config } = await import('../src/config')
  const app = express()
  app.use('/admin/assets', express.static(path.resolve(__dirname, '../admin-panel/assets')))
  app.use('/api/admin', createAdminRouter({ bot: {} as never }))
  const server = http.createServer(app)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('сервер не поднялся')
  }
  const base = `http://127.0.0.1:${address.port}`
  try {
    const unauth = await fetch(`${base}/api/admin/backup`)
    assert.equal(unauth.status, 403)
    const login = await fetch(`${base}/api/admin/panel-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: config.adminPanelUser,
        password: config.adminPanelPassword,
      }),
    })
    assert.equal(login.status, 200)
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
    assert.ok(cookie)
    const listRes = await fetch(`${base}/api/admin/backup`, { headers: { cookie } })
    assert.equal(listRes.status, 200)
    const list = (await listRes.json()) as { restoring: boolean; items: unknown[] }
    assert.equal(list.restoring, false)
    assert.ok(Array.isArray(list.items) && list.items.length >= 1)
    const missing = await fetch(`${base}/api/admin/backup/2000-01-01_000000/restore`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ restore_env: false }),
    })
    assert.equal(missing.status, 404)
    const js = await fetch(`${base}/admin/assets/admin.js`)
    assert.equal(js.status, 200)
    const source = await js.text()
    assert.ok(source.includes('backup-restore-btn'))
    assert.ok(source.includes('Загрузить и восстановить'))
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  }

  closeDb()

  fs.rmSync(root, { recursive: true, force: true })
  cleanupNewDataFiles()
  console.log('backup restore ok')
  process.exit(0)
}

main().catch((err: unknown) => {
  cleanupNewDataFiles()
  console.error(err)
  process.exit(1)
})
