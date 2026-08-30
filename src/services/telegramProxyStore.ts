import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { logger } from '../utils/logger'
import {
  parseProxyInput,
  parseProxyLines,
  parseVlessUri,
  type ParsedProxyInput,
  type ProxyKind,
} from '../utils/vlessUri'

const CONFIG_PATH = join(process.cwd(), 'data', 'telegram-proxies.json')
const MAX_PROXIES = 40
const MIN_SOCKS_PORT = 1024
const MAX_SOCKS_PORT = 65535

export type ProxyQuality = 'good' | 'poor' | 'down'

export interface ProxyProbeSnapshot {
  at: string
  quality: ProxyQuality
  latency_ms: number | null
  telegram_ok: boolean
  server_ok: boolean
  error: string | null
}

export interface TelegramProxyRecord {
  id: string
  name: string
  kind: ProxyKind
  uri: string
  host: string
  port: number
  username: string
  password: string
  created_at: string
  last_probe: ProxyProbeSnapshot | null
}

export interface TelegramProxyState {
  enabled: boolean
  activeId: string | null
  localSocksPort: number
  proxies: TelegramProxyRecord[]
  directProbe: ProxyProbeSnapshot | null
  updatedAt: string
}

export interface TelegramProxyPublicItem {
  id: string
  name: string
  kind: ProxyKind
  host: string
  port: number
  security: string | null
  network: string | null
  username_set: boolean
  uri_preview: string
  active: boolean
  last_probe: ProxyProbeSnapshot | null
}

export interface TelegramProxyPublicState {
  enabled: boolean
  active_id: string | null
  local_socks_port: number
  proxies: TelegramProxyPublicItem[]
  direct_probe: ProxyProbeSnapshot | null
  updated_at: string
}

function emptyState(): TelegramProxyState {
  return {
    enabled: false,
    activeId: null,
    localSocksPort: 10808,
    proxies: [],
    directProbe: null,
    updatedAt: new Date().toISOString(),
  }
}

function maskSecret(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length <= 4) {
    return '••••'
  }
  return `••••${trimmed.slice(-4)}`
}

function recordFromParsed(parsed: ParsedProxyInput, id?: string): TelegramProxyRecord {
  const now = new Date().toISOString()
  if (parsed.kind === 'vless') {
    return {
      id: id ?? randomUUID(),
      name: parsed.name,
      kind: 'vless',
      uri: parsed.uri,
      host: parsed.host,
      port: parsed.port,
      username: '',
      password: '',
      created_at: now,
      last_probe: null,
    }
  }
  const scheme = parsed.kind === 'socks5' ? 'socks5' : 'http'
  const auth =
    parsed.username || parsed.password
      ? `${encodeURIComponent(parsed.username)}:${encodeURIComponent(parsed.password)}@`
      : ''
  return {
    id: id ?? randomUUID(),
    name: parsed.name,
    kind: parsed.kind,
    uri: `${scheme}://${auth}${parsed.host}:${parsed.port}`,
    host: parsed.host,
    port: parsed.port,
    username: parsed.username,
    password: parsed.password,
    created_at: now,
    last_probe: null,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseProbe(raw: unknown): ProxyProbeSnapshot | null {
  if (!isRecord(raw)) {
    return null
  }
  const quality = raw.quality
  if (quality !== 'good' && quality !== 'poor' && quality !== 'down') {
    return null
  }
  return {
    at: typeof raw.at === 'string' ? raw.at : new Date().toISOString(),
    quality,
    latency_ms: typeof raw.latency_ms === 'number' && Number.isFinite(raw.latency_ms) ? raw.latency_ms : null,
    telegram_ok: raw.telegram_ok === true,
    server_ok: raw.server_ok === true,
    error: typeof raw.error === 'string' ? raw.error : null,
  }
}

function parseStoredProxy(raw: unknown): TelegramProxyRecord | null {
  if (!isRecord(raw)) {
    return null
  }
  const kind = raw.kind
  if (kind !== 'vless' && kind !== 'socks5' && kind !== 'http') {
    return null
  }
  const host = typeof raw.host === 'string' ? raw.host.trim() : ''
  const port = typeof raw.port === 'number' ? raw.port : Number.parseInt(String(raw.port ?? ''), 10)
  if (!host || !Number.isFinite(port) || port <= 0) {
    return null
  }
  return {
    id: typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id : randomUUID(),
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : host,
    kind,
    uri: typeof raw.uri === 'string' ? raw.uri.trim() : '',
    host,
    port,
    username: typeof raw.username === 'string' ? raw.username : '',
    password: typeof raw.password === 'string' ? raw.password : '',
    created_at: typeof raw.created_at === 'string' ? raw.created_at : new Date().toISOString(),
    last_probe: parseProbe(raw.last_probe),
  }
}

class TelegramProxyStore {
  private state: TelegramProxyState = emptyState()

  getState(): TelegramProxyState {
    return this.state
  }

  getActive(): TelegramProxyRecord | null {
    if (!this.state.enabled || !this.state.activeId) {
      return null
    }
    return this.state.proxies.find((item) => item.id === this.state.activeId) ?? null
  }

  async loadFromDisk(): Promise<void> {
    try {
      const raw = await readFile(CONFIG_PATH, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!isRecord(parsed)) {
        this.state = emptyState()
        await this.seedFromEnvIfEmpty()
        return
      }
      const proxies = Array.isArray(parsed.proxies)
        ? parsed.proxies.map(parseStoredProxy).filter((item): item is TelegramProxyRecord => item !== null)
        : []
      const localSocksPort = typeof parsed.localSocksPort === 'number' ? parsed.localSocksPort : 10808
      const activeId = typeof parsed.activeId === 'string' ? parsed.activeId : null
      this.state = {
        enabled: parsed.enabled === true,
        activeId: activeId && proxies.some((item) => item.id === activeId) ? activeId : (proxies[0]?.id ?? null),
        localSocksPort: Math.min(MAX_SOCKS_PORT, Math.max(MIN_SOCKS_PORT, Math.round(localSocksPort))),
        proxies: proxies.slice(0, MAX_PROXIES),
        directProbe: parseProbe(parsed.directProbe),
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      }
      await this.seedFromEnvIfEmpty()
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== 'ENOENT') {
        logger.error('telegramProxyStore: read failed', err)
      }
      this.state = emptyState()
      await this.seedFromEnvIfEmpty()
    }
  }

  toPublic(): TelegramProxyPublicState {
    return {
      enabled: this.state.enabled,
      active_id: this.state.activeId,
      local_socks_port: this.state.localSocksPort,
      proxies: this.state.proxies.map((item) => this.toPublicItem(item)),
      direct_probe: this.state.directProbe,
      updated_at: this.state.updatedAt,
    }
  }

  async setEnabled(enabled: boolean): Promise<TelegramProxyState> {
    this.state.enabled = enabled
    if (enabled && !this.state.activeId && this.state.proxies[0]) {
      this.state.activeId = this.state.proxies[0].id
    }
    await this.persist()
    return this.state
  }

  async setLocalSocksPort(port: number): Promise<TelegramProxyState> {
    if (!Number.isFinite(port) || port < MIN_SOCKS_PORT || port > MAX_SOCKS_PORT) {
      throw new Error(`Порт локального SOCKS: ${MIN_SOCKS_PORT}–${MAX_SOCKS_PORT}`)
    }
    this.state.localSocksPort = Math.round(port)
    await this.persist()
    return this.state
  }

  async addFromInput(raw: string, name?: string): Promise<TelegramProxyRecord> {
    if (this.state.proxies.length >= MAX_PROXIES) {
      throw new Error(`Можно сохранить не больше ${MAX_PROXIES} прокси`)
    }
    const record = recordFromParsed(parseProxyInput(raw))
    if (name && name.trim()) {
      record.name = name.trim()
    }
    this.state.proxies.push(record)
    if (!this.state.activeId) {
      this.state.activeId = record.id
    }
    await this.persist()
    return record
  }

  async addSocksOrHttp(input: {
    kind: 'socks5' | 'http'
    host: string
    port: number
    username?: string
    password?: string
    name?: string
  }): Promise<TelegramProxyRecord> {
    if (this.state.proxies.length >= MAX_PROXIES) {
      throw new Error(`Можно сохранить не больше ${MAX_PROXIES} прокси`)
    }
    const host = input.host.trim()
    if (!host) {
      throw new Error('Укажите хост прокси')
    }
    if (!Number.isFinite(input.port) || input.port <= 0 || input.port > 65535) {
      throw new Error('Некорректный порт')
    }
    const record = recordFromParsed({
      kind: input.kind,
      host,
      port: Math.round(input.port),
      username: (input.username ?? '').trim(),
      password: input.password ?? '',
      name: (input.name ?? '').trim() || host,
    })
    this.state.proxies.push(record)
    if (!this.state.activeId) {
      this.state.activeId = record.id
    }
    await this.persist()
    return record
  }

  async replaceAllFromText(text: string): Promise<TelegramProxyState> {
    const parsed = parseProxyLines(text)
    if (parsed.length > MAX_PROXIES) {
      throw new Error(`Можно сохранить не больше ${MAX_PROXIES} прокси`)
    }
    const previousActive = this.getActive()
    this.state.proxies = parsed.map((item) => recordFromParsed(item))
    const same = previousActive
      ? this.state.proxies.find(
          (item) => item.kind === previousActive.kind && item.host === previousActive.host && item.port === previousActive.port,
        )
      : null
    this.state.activeId = same?.id ?? this.state.proxies[0]?.id ?? null
    await this.persist()
    return this.state
  }

  async updateItem(
    id: string,
    patch: { name?: string; uri?: string; host?: string; port?: number; username?: string; password?: string },
  ): Promise<TelegramProxyRecord> {
    const index = this.state.proxies.findIndex((item) => item.id === id)
    const current = this.state.proxies[index]
    if (!current) {
      throw new Error('Прокси не найден')
    }
    let next = { ...current }
    if (patch.uri && patch.uri.trim()) {
      next = { ...recordFromParsed(parseProxyInput(patch.uri.trim()), current.id), created_at: current.created_at }
    }
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      next.name = name || next.host
    }
    if (next.kind !== 'vless') {
      if (patch.host !== undefined) {
        const host = patch.host.trim()
        if (!host) {
          throw new Error('Укажите хост прокси')
        }
        next.host = host
      }
      if (patch.port !== undefined) {
        if (!Number.isFinite(patch.port) || patch.port <= 0 || patch.port > 65535) {
          throw new Error('Некорректный порт')
        }
        next.port = Math.round(patch.port)
      }
      if (patch.username !== undefined) {
        next.username = patch.username
      }
      if (patch.password !== undefined) {
        next.password = patch.password
      }
      const scheme = next.kind === 'socks5' ? 'socks5' : 'http'
      const auth =
        next.username || next.password
          ? `${encodeURIComponent(next.username)}:${encodeURIComponent(next.password)}@`
          : ''
      next.uri = `${scheme}://${auth}${next.host}:${next.port}`
    }
    this.state.proxies[index] = next
    await this.persist()
    return next
  }

  async removeItem(id: string): Promise<void> {
    const exists = this.state.proxies.some((item) => item.id === id)
    if (!exists) {
      throw new Error('Прокси не найден')
    }
    this.state.proxies = this.state.proxies.filter((item) => item.id !== id)
    if (this.state.activeId === id) {
      this.state.activeId = this.state.proxies[0]?.id ?? null
    }
    if (this.state.proxies.length === 0) {
      this.state.enabled = false
    }
    await this.persist()
  }

  async activate(id: string): Promise<TelegramProxyRecord> {
    const item = this.state.proxies.find((row) => row.id === id)
    if (!item) {
      throw new Error('Прокси не найден')
    }
    this.state.activeId = id
    this.state.enabled = true
    await this.persist()
    return item
  }

  async setItemProbe(id: string, probe: ProxyProbeSnapshot): Promise<void> {
    const item = this.state.proxies.find((row) => row.id === id)
    if (!item) {
      return
    }
    item.last_probe = probe
    await this.persist()
  }

  async setDirectProbe(probe: ProxyProbeSnapshot): Promise<void> {
    this.state.directProbe = probe
    await this.persist()
  }

  getById(id: string): TelegramProxyRecord | null {
    return this.state.proxies.find((item) => item.id === id) ?? null
  }

  toPublicItem(item: TelegramProxyRecord): TelegramProxyPublicItem {
    let security: string | null = null
    let network: string | null = null
    let uriPreview = item.uri
    if (item.kind === 'vless' && item.uri) {
      try {
        const parsed = parseVlessUri(item.uri)
        security = parsed.security || null
        network = parsed.network || null
        uriPreview = `vless://${maskSecret(parsed.uuid)}@${parsed.host}:${parsed.port}`
      } catch {
        uriPreview = `vless://${maskSecret('uuid')}@${item.host}:${item.port}`
      }
    } else {
      const scheme = item.kind === 'socks5' ? 'socks5' : 'http'
      const user = item.username ? `${item.username}@` : ''
      uriPreview = `${scheme}://${user}${item.host}:${item.port}`
    }
    return {
      id: item.id,
      name: item.name,
      kind: item.kind,
      host: item.host,
      port: item.port,
      security,
      network,
      username_set: item.username.trim() !== '',
      uri_preview: uriPreview,
      active: this.state.activeId === item.id,
      last_probe: item.last_probe,
    }
  }

  private async seedFromEnvIfEmpty(): Promise<void> {
    if (this.state.proxies.length > 0) {
      return
    }
    const raw = (process.env.TELEGRAM_PROXY_URL || '').trim()
    if (!raw) {
      return
    }
    try {
      const record = recordFromParsed(parseProxyInput(raw))
      this.state.proxies = [record]
      this.state.activeId = record.id
      this.state.enabled = true
      await this.persist()
      logger.info('[telegramProxy] seeded from TELEGRAM_PROXY_URL', { kind: record.kind, host: record.host })
    } catch (err: unknown) {
      logger.warn('[telegramProxy] TELEGRAM_PROXY_URL invalid', { err })
    }
  }

  private async persist(): Promise<void> {
    this.state.updatedAt = new Date().toISOString()
    const dir = dirname(CONFIG_PATH)
    await mkdir(dir, { recursive: true })
    await writeFile(CONFIG_PATH, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
  }
}

export const telegramProxyStore = new TelegramProxyStore()
