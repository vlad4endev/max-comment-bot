import { createReadStream, createWriteStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'

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
