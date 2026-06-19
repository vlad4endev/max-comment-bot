import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { logger } from '../utils/logger'

const CONFIG_PATH = join(process.cwd(), 'data', 'log-ai-config.json')

export type LogAiProvider = 'openrouter' | 'openai' | 'custom'

export interface LogAiConfigFile {
  provider: LogAiProvider
  api_key: string
  base_url: string
  model: string
  updated_at: string
}

function parseProvider(raw: unknown): LogAiProvider {
  if (raw === 'openrouter' || raw === 'openai' || raw === 'custom') {
    return raw
  }
  return 'openrouter'
}

function maskApiKey(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length <= 4) return '••••'
  return `••••••••${trimmed.slice(-4)}`
}

class LogAiSettingsStore {
  private config: LogAiConfigFile | null = null

  async loadFromDisk(): Promise<void> {
    try {
      const raw = await readFile(CONFIG_PATH, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) {
        this.config = null
        return
      }
      const o = parsed as Record<string, unknown>
      const apiKey = typeof o.api_key === 'string' ? o.api_key.trim() : ''
      const model = typeof o.model === 'string' ? o.model.trim() : ''
      const baseUrl = typeof o.base_url === 'string' ? o.base_url.trim().replace(/\/+$/, '') : ''
      if (!apiKey) {
        this.config = null
        return
      }
      this.config = {
        provider: parseProvider(o.provider),
        api_key: apiKey,
        base_url: baseUrl,
        model,
        updated_at: typeof o.updated_at === 'string' ? o.updated_at : new Date().toISOString(),
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') {
        this.config = null
        return
      }
      logger.error('logAiSettingsStore: read failed', err)
      this.config = null
    }
  }

  getConfig(): LogAiConfigFile | null {
    return this.config
  }

  getApiKeyPreview(): string {
    return this.config ? maskApiKey(this.config.api_key) : ''
  }

  isConfigured(): boolean {
    return this.config !== null && this.config.api_key.trim() !== ''
  }

  async save(patch: {
    provider?: LogAiProvider
    api_key?: string
    base_url?: string
    model?: string
  }): Promise<LogAiConfigFile> {
    const prev = this.config
    const apiKey =
      typeof patch.api_key === 'string' && patch.api_key.trim() !== ''
        ? patch.api_key.trim()
        : (prev?.api_key ?? '')
    if (!apiKey) {
      throw new Error('api_key required')
    }
    const next: LogAiConfigFile = {
      provider: patch.provider ?? prev?.provider ?? 'openrouter',
      api_key: apiKey,
      base_url:
        typeof patch.base_url === 'string'
          ? patch.base_url.trim().replace(/\/+$/, '')
          : (prev?.base_url ?? ''),
      model: typeof patch.model === 'string' ? patch.model.trim() : (prev?.model ?? ''),
      updated_at: new Date().toISOString(),
    }
    if (!next.model) {
      throw new Error('model required')
    }
    if (next.provider === 'custom' && !next.base_url) {
      throw new Error('base_url required for custom provider')
    }
    this.config = next
    await this.persist()
    logger.info('logAiSettingsStore: saved', { provider: next.provider, model: next.model })
    return next
  }

  private async persist(): Promise<void> {
    if (!this.config) return
    const dir = dirname(CONFIG_PATH)
    await mkdir(dir, { recursive: true })
    await writeFile(CONFIG_PATH, `${JSON.stringify(this.config, null, 2)}\n`, 'utf8')
  }
}

export const logAiSettingsStore = new LogAiSettingsStore()
