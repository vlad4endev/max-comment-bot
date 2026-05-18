import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { logger } from './logger'

const ENV_PATH = join(process.cwd(), '.env')

function formatEnvValue(value: string): string {
  if (/[\s#"'\\]/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return value
}

function parseEnvLine(line: string): { key: string; raw: string } | null {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return null
  const eq = trimmed.indexOf('=')
  if (eq <= 0) return null
  return { key: trimmed.slice(0, eq).trim(), raw: line }
}

/**
 * Добавляет или обновляет переменную в корневом `.env`.
 */
export async function upsertRootEnvVar(key: string, value: string): Promise<void> {
  let lines: string[] = []
  try {
    const content = await readFile(ENV_PATH, 'utf8')
    lines = content.split('\n')
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT') throw err
  }

  const newLine = `${key}=${formatEnvValue(value)}`
  let replaced = false
  const next = lines.map((line) => {
    const parsed = parseEnvLine(line)
    if (parsed?.key === key) {
      replaced = true
      return newLine
    }
    return line
  })

  if (!replaced) {
    if (next.length > 0 && next[next.length - 1] !== '') {
      next.push('')
    }
    next.push(newLine)
  }

  const output = next.join('\n')
  await writeFile(ENV_PATH, output.endsWith('\n') ? output : `${output}\n`, 'utf8')
  process.env[key] = value
  logger.info('envFile: updated', { key })
}

/**
 * Удаляет переменную из корневого `.env`.
 */
export async function removeRootEnvVar(key: string): Promise<void> {
  let content: string
  try {
    content = await readFile(ENV_PATH, 'utf8')
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') {
      delete process.env[key]
      return
    }
    throw err
  }

  const lines = content.split('\n').filter((line) => parseEnvLine(line)?.key !== key)
  const output = lines.join('\n')
  await writeFile(ENV_PATH, output.endsWith('\n') ? output : `${output}\n`, 'utf8')
  delete process.env[key]
  logger.info('envFile: removed', { key })
}
