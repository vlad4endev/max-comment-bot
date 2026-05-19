/**
 * Примеры:
 * logger.info('Бот запущен')
 * logger.error('Ошибка подключения', error)
 * logger.warn('Большой payload', { size: 150 })
 * logger.debug('Переменные окружения загружены')
 */

import { existsSync, renameSync, statSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { serializeAdminLogLine } from './adminLogFormat'

const RUNTIME_LOG_PATH = join(process.cwd(), 'data', 'runtime.log')
const MAX_LOG_SIZE = 50 * 1024 * 1024
const ADMIN_LOG_BUFFER_MAX = 500
const adminLogLines: string[] = []

export function rotateRuntimeLogIfNeeded(): void {
  try {
    if (!existsSync(RUNTIME_LOG_PATH)) {
      return
    }
    if (statSync(RUNTIME_LOG_PATH).size > MAX_LOG_SIZE) {
      renameSync(RUNTIME_LOG_PATH, `${RUNTIME_LOG_PATH}.old`)
    }
  } catch {
    /* ignore rotation errors */
  }
}

const LOG_ROTATION_INTERVAL_MS = 60 * 60 * 1000
let logRotationInterval: ReturnType<typeof setInterval> | undefined

/** Проверка размера при старте и раз в час. */
export function startRuntimeLogRotationScheduler(): void {
  rotateRuntimeLogIfNeeded()
  stopRuntimeLogRotationScheduler()
  logRotationInterval = setInterval(() => {
    rotateRuntimeLogIfNeeded()
  }, LOG_ROTATION_INTERVAL_MS)
}

export function stopRuntimeLogRotationScheduler(): void {
  if (logRotationInterval !== undefined) {
    clearInterval(logRotationInterval)
    logRotationInterval = undefined
  }
}

function pushAdminLogLine(line: string): void {
  adminLogLines.push(line)
  if (adminLogLines.length > ADMIN_LOG_BUFFER_MAX) {
    adminLogLines.splice(0, adminLogLines.length - ADMIN_LOG_BUFFER_MAX)
  }
  rotateRuntimeLogIfNeeded()
  void mkdir(dirname(RUNTIME_LOG_PATH), { recursive: true })
    .then(() => appendFile(RUNTIME_LOG_PATH, `${line}\n`, 'utf8'))
    .catch(() => {
      /* ignore disk errors for log tail */
    })
}

/** Последние строки консольного лога (и дубль в data/runtime.log при возможности). */
export function getAdminLogTail(maxLines: number): string[] {
  const n = Math.min(Math.max(1, maxLines), adminLogLines.length)
  return adminLogLines.slice(-n)
}

const RESET = '\x1b[0m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'

const isDevelopment = process.env.NODE_ENV === 'development'

export class Logger {
  /**
   * @example logger.info('Бот запущен')
   * @example logger.info('Событие', { id: 1 })
   */
  info(message: string, data?: any): void {
    this.emit('INFO', GREEN, message, console.log, data)
  }

  /**
   * @example logger.error('Ошибка подключения', error)
   */
  error(message: string, error?: any): void {
    this.emit('ERROR', RED, message, console.error, error)
  }

  /**
   * @example logger.warn('Большой payload', { size: 150 })
   */
  warn(message: string, data?: any): void {
    this.emit('WARN', YELLOW, message, console.warn, data)
  }

  /**
   * Только при NODE_ENV === 'development'.
   * @example logger.debug('Переменные окружения загружены')
   */
  debug(message: string, data?: any): void {
    if (!isDevelopment) {
      return
    }
    this.emit('DEBUG', CYAN, message, console.log, data)
  }

  private emit(
    level: string,
    color: string,
    message: string,
    write: typeof console.log,
    extra?: any,
  ): void {
    const timestamp = new Date().toISOString()
    const header = `${color}${timestamp} [${level}] ${message}${RESET}`
    pushAdminLogLine(serializeAdminLogLine(level, message, extra))

    if (extra !== undefined) {
      write(header, extra)
    } else {
      write(header)
    }
  }
}

/**
 * @example logger.info('Бот запущен')
 * @example logger.error('Ошибка подключения', error)
 * @example logger.warn('Большой payload', { size: 150 })
 * @example logger.debug('Переменные окружения загружены')
 */
export const logger = new Logger()
