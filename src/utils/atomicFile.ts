import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Цепочка записей на файл: параллельные persist() идут по очереди, а не перемешиваются. */
const writeQueues = new Map<string, Promise<void>>()

let tmpCounter = 0

function tmpPathFor(path: string): string {
  tmpCounter += 1
  return `${path}.${process.pid}.${tmpCounter}.tmp`
}

/**
 * Атомарная запись: во временный файл рядом, затем rename.
 * Падение процесса посреди записи оставляет прежний файл целым.
 */
export async function atomicWriteFile(path: string, content: string, mode?: number): Promise<void> {
  const previous = writeQueues.get(path) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await mkdir(dirname(path), { recursive: true })
      const tmp = tmpPathFor(path)
      await writeFile(tmp, content, mode === undefined ? 'utf8' : { encoding: 'utf8', mode })
      await rename(tmp, path)
    })
  writeQueues.set(path, next)
  try {
    await next
  } finally {
    if (writeQueues.get(path) === next) {
      writeQueues.delete(path)
    }
  }
}

/** Синхронный вариант для мест, где запись уже синхронная (mtproto-config). */
export function atomicWriteFileSync(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = tmpPathFor(path)
  writeFileSync(tmp, content, mode === undefined ? 'utf8' : { encoding: 'utf8', mode })
  renameSync(tmp, path)
}
