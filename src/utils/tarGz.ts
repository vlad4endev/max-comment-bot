import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip, createGunzip } from 'node:zlib'

interface TarEntry {
  absPath: string
  archivePath: string
  isDir: boolean
  size: number
  mtimeSec: number
}

function toPosix(p: string): string {
  return p.split(sep).join('/')
}

function octalField(value: number, length: number): Buffer {
  const body = value.toString(8).padStart(length - 1, '0')
  const buf = Buffer.alloc(length, 0)
  buf.write(body, 0, length - 1, 'utf8')
  return buf
}

function writeString(buf: Buffer, offset: number, value: string, length: number): void {
  const raw = Buffer.from(value, 'utf8')
  const n = Math.min(raw.length, length - 1)
  raw.copy(buf, offset, 0, n)
}

function splitUstarName(archivePath: string): { name: string; prefix: string } {
  const posix = archivePath.replace(/^\/+/, '')
  const bytes = Buffer.from(posix, 'utf8')
  if (bytes.length <= 100) {
    return { name: posix, prefix: '' }
  }
  const parts = posix.split('/')
  for (let i = 1; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i).join('/')
    const name = parts.slice(i).join('/')
    if (Buffer.from(prefix, 'utf8').length <= 155 && Buffer.from(name, 'utf8').length <= 100) {
      return { name, prefix }
    }
  }
  throw new Error(`Путь слишком длинный для tar: ${posix}`)
}

function buildHeader(entry: TarEntry): Buffer {
  const header = Buffer.alloc(512, 0)
  const { name, prefix } = splitUstarName(entry.isDir ? `${entry.archivePath}/` : entry.archivePath)
  writeString(header, 0, name, 100)
  octalField(entry.isDir ? 0o755 : 0o644, 8).copy(header, 100)
  octalField(0, 8).copy(header, 108)
  octalField(0, 8).copy(header, 116)
  octalField(entry.isDir ? 0 : entry.size, 12).copy(header, 124)
  octalField(entry.mtimeSec, 12).copy(header, 136)
  header.fill(0x20, 148, 156)
  header[156] = entry.isDir ? 0x35 : 0x30
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  writeString(header, 265, 'node', 32)
  writeString(header, 297, 'node', 32)
  if (prefix) {
    writeString(header, 345, prefix, 155)
  }
  let sum = 0
  for (let i = 0; i < 512; i += 1) {
    sum += header[i] ?? 0
  }
  const chk = `${sum.toString(8).padStart(6, '0')}\0 `
  header.write(chk, 148, 8, 'ascii')
  return header
}

async function collectEntries(rootDir: string): Promise<TarEntry[]> {
  const entries: TarEntry[] = []

  async function walk(dir: string): Promise<void> {
    const names = await readdir(dir)
    names.sort()
    for (const name of names) {
      if (name === '.' || name === '..') continue
      const absPath = join(dir, name)
      const st = await stat(absPath)
      const archivePath = toPosix(relative(rootDir, absPath))
      if (!archivePath || archivePath.startsWith('..')) continue
      if (st.isDirectory()) {
        entries.push({
          absPath,
          archivePath,
          isDir: true,
          size: 0,
          mtimeSec: Math.floor(st.mtimeMs / 1000),
        })
        await walk(absPath)
      } else if (st.isFile()) {
        entries.push({
          absPath,
          archivePath,
          isDir: false,
          size: st.size,
          mtimeSec: Math.floor(st.mtimeMs / 1000),
        })
      }
    }
  }

  await walk(rootDir)
  return entries
}

function zeroPad(size: number): Buffer | null {
  const pad = (512 - (size % 512)) % 512
  return pad > 0 ? Buffer.alloc(pad, 0) : null
}

async function writeTo(tar: PassThrough, chunk: Buffer): Promise<void> {
  if (tar.write(chunk)) return
  await new Promise<void>((resolve, reject) => {
    tar.once('drain', resolve)
    tar.once('error', reject)
  })
}

async function pipeFile(tar: PassThrough, filePath: string): Promise<void> {
  const rs = createReadStream(filePath)
  await new Promise<void>((resolve, reject) => {
    rs.once('error', (err) => {
      rs.destroy()
      reject(err)
    })
    rs.once('end', () => resolve())
    rs.pipe(tar, { end: false })
  })
}

/**
 * Packs `rootDir` into a gzipped ustar archive at `outFile`.
 */
export async function packDirectoryToTarGz(rootDir: string, outFile: string): Promise<void> {
  const entries = await collectEntries(rootDir)
  const tar = new PassThrough()
  const gzip = createGzip({ level: 9 })
  const out = createWriteStream(outFile)
  const piping = pipeline(tar, gzip, out)

  try {
    for (const entry of entries) {
      await writeTo(tar, buildHeader(entry))
      if (entry.isDir) continue
      await pipeFile(tar, entry.absPath)
      const pad = zeroPad(entry.size)
      if (pad) {
        await writeTo(tar, pad)
      }
    }
    await writeTo(tar, Buffer.alloc(1024, 0))
    tar.end()
    await piping
  } catch (err) {
    tar.destroy()
    gzip.destroy()
    out.destroy()
    throw err
  }
}

export class TarExtractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TarExtractError'
  }
}

const MAX_ENTRY_BYTES = 2 * 1024 * 1024 * 1024
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024
const MAX_ENTRIES = 200_000

/** Разбивает путь архива и запрещает выход за каталог назначения. */
export function safeArchiveParts(rel: string): string[] {
  const normalized = rel.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '')
  if (!normalized || normalized.includes('\0')) {
    throw new TarExtractError('Недопустимый путь в архиве')
  }
  const parts = normalized.split('/').filter((part) => part.length > 0 && part !== '.')
  if (parts.length === 0 || parts.some((part) => part === '..')) {
    throw new TarExtractError('Недопустимый путь в архиве')
  }
  return parts
}

export function resolveInside(root: string, parts: string[]): string {
  const dest = resolve(root, ...parts)
  const base = resolve(root)
  if (dest !== base && !dest.startsWith(base + sep)) {
    throw new TarExtractError('Недопустимый путь в архиве')
  }
  return dest
}

class ChunkReader {
  private chunks: Buffer[] = []
  private buffered = 0
  private ended = false
  private error: Error | null = null
  private waiter: (() => void) | null = null
  onResume: (() => void) | null = null
  private paused = false

  bufferedBytes(): number {
    return this.buffered
  }

  push(buf: Buffer): boolean {
    if (buf.length === 0) return false
    this.chunks.push(buf)
    this.buffered += buf.length
    this.wake()
    if (this.buffered > 8 * 1024 * 1024) {
      this.paused = true
      return true
    }
    return false
  }

  finish(): void {
    this.ended = true
    this.wake()
  }

  fail(err: Error): void {
    this.error = err
    this.ended = true
    this.wake()
  }

  private wake(): void {
    const waiter = this.waiter
    this.waiter = null
    if (waiter) waiter()
  }

  private wait(): Promise<void> {
    return new Promise((resolveWait) => {
      this.waiter = resolveWait
    })
  }

  private afterConsume(): void {
    if (this.paused && this.buffered < 1024 * 1024) {
      this.paused = false
      this.onResume?.()
    }
  }

  async readExact(n: number): Promise<Buffer | null> {
    if (n === 0) return Buffer.alloc(0)
    while (this.buffered < n && !this.ended && !this.error) {
      await this.wait()
    }
    if (this.error) throw this.error
    if (this.buffered === 0 && this.ended) return null
    if (this.buffered < n) {
      throw new TarExtractError('Архив обрезан')
    }
    const out = Buffer.alloc(n)
    let offset = 0
    while (offset < n) {
      const head = this.chunks[0]
      if (!head) break
      const take = Math.min(head.length, n - offset)
      head.copy(out, offset, 0, take)
      offset += take
      if (take === head.length) this.chunks.shift()
      else this.chunks[0] = head.subarray(take)
    }
    this.buffered -= n
    this.afterConsume()
    return out
  }

  async discard(n: number): Promise<void> {
    let left = n
    while (left > 0) {
      while (this.buffered === 0 && !this.ended && !this.error) {
        await this.wait()
      }
      if (this.error) throw this.error
      const head = this.chunks[0]
      if (!head || this.buffered === 0) throw new TarExtractError('Архив обрезан')
      const take = Math.min(head.length, left)
      if (take === head.length) this.chunks.shift()
      else this.chunks[0] = head.subarray(take)
      this.buffered -= take
      left -= take
    }
    this.afterConsume()
  }

  async writeExactToFile(n: number, filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true })
    const fh = await open(filePath, 'w')
    try {
      let left = n
      while (left > 0) {
        while (this.buffered === 0 && !this.ended && !this.error) {
          await this.wait()
        }
        if (this.error) throw this.error
        const head = this.chunks[0]
        if (!head || this.buffered === 0) throw new TarExtractError('Архив обрезан')
      const take = Math.min(head.length, left)
      let offset = 0
      while (offset < take) {
        const { bytesWritten } = await fh.write(head.subarray(offset, take))
        if (bytesWritten <= 0) {
          throw new TarExtractError('Не удалось записать файл из архива')
        }
        offset += bytesWritten
      }
      if (take === head.length) this.chunks.shift()
      else this.chunks[0] = head.subarray(take)
        this.buffered -= take
        left -= take
      }
    } finally {
      await fh.close()
    }
    this.afterConsume()
  }
}

function parseOctal(field: Buffer): number {
  const text = field.toString('utf8').replace(/\0.*$/s, '').trim()
  if (!text) return 0
  if (!/^[0-7]+$/.test(text)) {
    throw new TarExtractError('Некорректное поле tar')
  }
  const value = Number.parseInt(text, 8)
  if (!Number.isFinite(value) || value < 0) {
    throw new TarExtractError('Некорректное поле tar')
  }
  return value
}

function readCString(field: Buffer): string {
  const zero = field.indexOf(0)
  const slice = zero === -1 ? field : field.subarray(0, zero)
  return slice.toString('utf8')
}

function isZeroBlock(header: Buffer): boolean {
  for (let i = 0; i < header.length; i += 1) {
    if (header[i] !== 0) return false
  }
  return true
}

function verifyChecksum(header: Buffer): void {
  const stored = parseOctal(header.subarray(148, 156))
  let sum = 0
  for (let i = 0; i < 512; i += 1) {
    sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0)
  }
  if (sum !== stored) {
    throw new TarExtractError('Архив повреждён: не сходится контрольная сумма')
  }
}

function headerPath(header: Buffer): string {
  const name = readCString(header.subarray(0, 100))
  const magic = header.toString('ascii', 257, 262)
  const prefix = magic.startsWith('ustar') ? readCString(header.subarray(345, 500)) : ''
  return prefix ? `${prefix}/${name}` : name
}

/**
 * Распаковывает gzip/ustar-архив, который собирает {@link packDirectoryToTarGz}.
 * Симлинки и пути с `..` отклоняются.
 */
export async function extractTarGz(
  archivePath: string,
  destDir: string,
): Promise<{ files: number; bytes: number }> {
  await mkdir(destDir, { recursive: true })
  const reader = new ChunkReader()
  const input = createReadStream(archivePath)
  const gunzip = createGunzip()
  let streamError: Error | null = null
  const failed = (err: unknown): void => {
    const error = err instanceof Error ? err : new Error(String(err))
    streamError = error
    reader.fail(error)
  }
  input.on('error', failed)
  gunzip.on('error', failed)
  gunzip.on('end', () => reader.finish())
  gunzip.on('data', (chunk: Buffer) => {
    if (reader.push(chunk)) gunzip.pause()
  })
  reader.onResume = () => {
    if (!gunzip.isPaused()) return
    gunzip.resume()
  }
  input.pipe(gunzip)

  let files = 0
  let bytes = 0
  try {
    for (;;) {
      const header = await reader.readExact(512)
      if (!header) break
      if (isZeroBlock(header)) break
      verifyChecksum(header)
      const typeflag = header[156] ?? 0x30
      const size = parseOctal(header.subarray(124, 136))
      if (size > MAX_ENTRY_BYTES) {
        throw new TarExtractError('Файл в архиве слишком большой')
      }
      bytes += size
      if (bytes > MAX_TOTAL_BYTES) {
        throw new TarExtractError('Архив слишком большой')
      }
      const pad = (512 - (size % 512)) % 512
      const rel = headerPath(header).replace(/\/+$/, '')

      if (typeflag === 0x35) {
        if (rel) {
          const parts = safeArchiveParts(rel)
          await mkdir(resolveInside(destDir, parts), { recursive: true })
        }
        await reader.discard(size + pad)
        continue
      }

      if (typeflag === 0x67 || typeflag === 0x78 || typeflag === 0x4c || typeflag === 0x4b) {
        await reader.discard(size + pad)
        continue
      }

      if (typeflag !== 0x30 && typeflag !== 0x00) {
        throw new TarExtractError('В архиве есть ссылка или неподдерживаемый тип файла')
      }

      if (!rel) {
        await reader.discard(size + pad)
        continue
      }
      files += 1
      if (files > MAX_ENTRIES) {
        throw new TarExtractError('В архиве слишком много файлов')
      }
      const dest = resolveInside(destDir, safeArchiveParts(rel))
      await reader.writeExactToFile(size, dest)
      if (pad) await reader.discard(pad)
    }
    if (streamError) throw streamError
    return { files, bytes }
  } catch (err) {
    input.destroy()
    gunzip.destroy()
    if (err instanceof TarExtractError) throw err
    throw new TarExtractError(err instanceof Error ? err.message : 'Не удалось распаковать архив')
  } finally {
    input.destroy()
    gunzip.destroy()
  }
}
