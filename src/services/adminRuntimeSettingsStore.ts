import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { logger } from '../utils/logger'

const MIN_POLL_MS = 3_000

const DEFAULT_PATH = join(process.cwd(), 'data', 'admin-runtime.json')

function pollMsFromEnv(): number {
  const n = Number.parseInt(process.env.CHANNEL_POLL_INTERVAL_MS ?? '', 10)
  if (Number.isFinite(n) && n >= MIN_POLL_MS) {
    return n
  }
  return 30_000
}

interface FileShape {
  poll_interval_ms: number
}

export class AdminRuntimeSettingsStore {
  private pollIntervalMs: number
  private readonly filePath: string

  constructor(filePath: string = DEFAULT_PATH) {
    this.filePath = filePath
    this.pollIntervalMs = Math.max(MIN_POLL_MS, pollMsFromEnv())
  }

  getPollIntervalMs(): number {
    return this.pollIntervalMs
  }

  async loadFromDisk(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw) as unknown
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as FileShape).poll_interval_ms === 'number' &&
        Number.isFinite((parsed as FileShape).poll_interval_ms)
      ) {
        this.pollIntervalMs = Math.max(MIN_POLL_MS, Math.round((parsed as FileShape).poll_interval_ms))
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        logger.debug('adminRuntimeSettings: no file, using env/default')
        return
      }
      logger.error('adminRuntimeSettings: read failed', e)
    }
  }

  async setPollIntervalMs(ms: number): Promise<number> {
    this.pollIntervalMs = Math.max(MIN_POLL_MS, Math.round(ms))
    await this.persist()
    return this.pollIntervalMs
  }

  private async persist(): Promise<void> {
    const dir = dirname(this.filePath)
    await mkdir(dir, { recursive: true })
    const body: FileShape = { poll_interval_ms: this.pollIntervalMs }
    await writeFile(this.filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  }
}

export const adminRuntimeSettingsStore = new AdminRuntimeSettingsStore()
