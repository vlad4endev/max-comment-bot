import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

import { logger } from '../utils/logger'
import { normalizeTelegramLinkedChatsForApi } from '../utils/telegramLinkedChats'
import type { PlatformChannelInfo, TelegramChatType } from './integrationPlatformClient'

const DATA_PATH = join(process.cwd(), 'data', 'integrations.json')

export type IntegrationPlatform = 'telegram' | 'vk'
export type FlowPlatform = 'telegram' | 'vk' | 'max'

export interface IntegrationStats {
  totalPosts: number
  lastActivity: string | null
}

export interface IntegrationLinkedChat {
  id: string
  title: string
  username?: string
  type?: TelegramChatType
  botIsAdmin?: boolean
}

function parseTelegramChatType(raw: unknown): TelegramChatType | undefined {
  if (raw === 'channel') return 'channel'
  if (raw === 'group') return 'group'
  if (raw === 'supergroup') return 'supergroup'
  if (raw === 'private') return 'private'
  if (raw === 'unknown') return 'unknown'
  return undefined
}

export interface IntegrationRecord {
  id: string
  platform: IntegrationPlatform
  name: string
  token: string
  groupId?: string
  status: 'connected' | 'disconnected' | 'error'
  connectedAt: string
  stats: IntegrationStats
  /** Каналы/чаты TG (или сообщества VK), доступные боту — для потоков, цепочек и автопостинга. */
  linkedChats?: IntegrationLinkedChat[]
  linkedChatsUpdatedAt?: string
}

export interface FlowFilters {
  keywords: string[]
  excludeKeywords: string[]
  mediaOnly: boolean
  delaySeconds: number
}

export interface FlowSource {
  integrationId: string
  platform: FlowPlatform
  channelUsername?: string
  channelId?: string
  contentTypes?: string[]
}

export interface FlowDestination {
  platform: FlowPlatform
  channelId: string
  integrationId?: string
  addCommentsButton?: boolean
  signature?: string
}

export interface FlowStats {
  totalForwarded: number
  lastForwardedAt: string | null
  errors: number
}

export interface FlowRecord {
  id: string
  name: string
  enabled: boolean
  source: FlowSource
  filters: FlowFilters
  destination: FlowDestination
  stats: FlowStats
  createdAt: string
}

export interface ForwardedLogEntry {
  id: string
  flowId: string
  fromPlatform: string
  fromChannel: string
  toPlatform: string
  toChannel: string
  preview: string
  forwardedAt: string
}

interface IntegrationsFile {
  integrations: IntegrationRecord[]
  flows: FlowRecord[]
  forwardedLog: ForwardedLogEntry[]
}

function defaultFile(): IntegrationsFile {
  return { integrations: [], flows: [], forwardedLog: [] }
}

function isIntegrationPlatform(v: unknown): v is IntegrationPlatform {
  return v === 'telegram' || v === 'vk'
}

function isFlowPlatform(v: unknown): v is FlowPlatform {
  return v === 'telegram' || v === 'vk' || v === 'max'
}

function parseFilters(raw: unknown): FlowFilters | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const keywords = Array.isArray(o.keywords)
    ? o.keywords.filter((k): k is string => typeof k === 'string')
    : []
  const excludeKeywords = Array.isArray(o.excludeKeywords)
    ? o.excludeKeywords.filter((k): k is string => typeof k === 'string')
    : []
  const mediaOnly = o.mediaOnly === true
  const delaySeconds =
    typeof o.delaySeconds === 'number' && Number.isFinite(o.delaySeconds) ? o.delaySeconds : 0
  return { keywords, excludeKeywords, mediaOnly, delaySeconds }
}

function parseSource(raw: unknown): FlowSource | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (!isFlowPlatform(o.platform) || typeof o.integrationId !== 'string') return null
  return {
    integrationId: o.integrationId,
    platform: o.platform,
    channelUsername: typeof o.channelUsername === 'string' ? o.channelUsername : undefined,
    channelId: typeof o.channelId === 'string' ? o.channelId : undefined,
    contentTypes: Array.isArray(o.contentTypes)
      ? o.contentTypes.filter((c): c is string => typeof c === 'string')
      : undefined,
  }
}

function parseDestination(raw: unknown): FlowDestination | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (!isFlowPlatform(o.platform) || typeof o.channelId !== 'string') return null
  return {
    platform: o.platform,
    channelId: o.channelId,
    integrationId: typeof o.integrationId === 'string' ? o.integrationId : undefined,
    addCommentsButton: o.addCommentsButton === true,
    signature: typeof o.signature === 'string' ? o.signature : undefined,
  }
}

function parseFlow(raw: unknown): FlowRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.name !== 'string') return null
  const source = parseSource(o.source)
  const destination = parseDestination(o.destination)
  const filters = parseFilters(o.filters)
  if (!source || !destination || !filters) return null
  const statsRaw = o.stats as Record<string, unknown> | undefined
  const stats: FlowStats = {
    totalForwarded:
      typeof statsRaw?.totalForwarded === 'number' ? statsRaw.totalForwarded : 0,
    lastForwardedAt:
      typeof statsRaw?.lastForwardedAt === 'string' ? statsRaw.lastForwardedAt : null,
    errors: typeof statsRaw?.errors === 'number' ? statsRaw.errors : 0,
  }
  return {
    id: o.id,
    name: o.name,
    enabled: o.enabled !== false,
    source,
    filters,
    destination,
    stats,
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : new Date().toISOString(),
  }
}

function parseLinkedChat(raw: unknown): IntegrationLinkedChat | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.title !== 'string') return null
  return {
    id: o.id,
    title: o.title,
    username: typeof o.username === 'string' ? o.username : undefined,
    type: parseTelegramChatType(o.type),
    botIsAdmin: o.botIsAdmin === true,
  }
}

function parseIntegration(raw: unknown): IntegrationRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || !isIntegrationPlatform(o.platform)) return null
  if (typeof o.name !== 'string' || typeof o.token !== 'string') return null
  const statsRaw = o.stats as Record<string, unknown> | undefined
  const linkedChats = Array.isArray(o.linkedChats)
    ? o.linkedChats.map(parseLinkedChat).filter((x): x is IntegrationLinkedChat => x !== null)
    : undefined
  return {
    id: o.id,
    platform: o.platform,
    name: o.name,
    token: o.token,
    groupId: typeof o.groupId === 'string' ? o.groupId : undefined,
    status:
      o.status === 'connected' || o.status === 'disconnected' || o.status === 'error'
        ? o.status
        : 'disconnected',
    connectedAt: typeof o.connectedAt === 'string' ? o.connectedAt : new Date().toISOString(),
    stats: {
      totalPosts: typeof statsRaw?.totalPosts === 'number' ? statsRaw.totalPosts : 0,
      lastActivity:
        typeof statsRaw?.lastActivity === 'string' ? statsRaw.lastActivity : null,
    },
    linkedChats: linkedChats?.length ? linkedChats : undefined,
    linkedChatsUpdatedAt:
      typeof o.linkedChatsUpdatedAt === 'string' ? o.linkedChatsUpdatedAt : undefined,
  }
}

class IntegrationsStore {
  private data: IntegrationsFile = defaultFile()
  private loaded = false

  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await readFile(DATA_PATH, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed === 'object' && parsed !== null) {
        const o = parsed as Record<string, unknown>
        const integrations = Array.isArray(o.integrations)
          ? o.integrations.map(parseIntegration).filter((x): x is IntegrationRecord => x !== null)
          : []
        const flows = Array.isArray(o.flows)
          ? o.flows.map(parseFlow).filter((x): x is FlowRecord => x !== null)
          : []
        const forwardedLog = Array.isArray(o.forwardedLog)
          ? (o.forwardedLog as unknown[]).filter((e): e is ForwardedLogEntry => {
              if (typeof e !== 'object' || e === null) return false
              const x = e as Record<string, unknown>
              return (
                typeof x.id === 'string' &&
                typeof x.flowId === 'string' &&
                typeof x.forwardedAt === 'string'
              )
            })
          : []
        this.data = { integrations, flows, forwardedLog }
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') {
        await this.persist()
        logger.info('integrationsStore: created empty data/integrations.json')
      } else {
        logger.warn('integrationsStore: load failed, using empty', err)
      }
    }
    this.loaded = true
  }

  /** Перечитать файл с диска (после ручного редактирования data/integrations.json). */
  async reloadFromDisk(): Promise<void> {
    this.loaded = false
    await this.load()
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(DATA_PATH), { recursive: true })
    await writeFile(DATA_PATH, JSON.stringify(this.data, null, 2), 'utf8')
  }

  getIntegrations(): IntegrationRecord[] {
    return [...this.data.integrations]
  }

  getIntegration(id: string): IntegrationRecord | undefined {
    return this.data.integrations.find((i) => i.id === id)
  }

  async upsertIntegration(
    input: Omit<IntegrationRecord, 'id' | 'connectedAt' | 'stats'> & {
      id?: string
      connectedAt?: string
      stats?: IntegrationStats
    },
  ): Promise<IntegrationRecord> {
    const now = new Date().toISOString()
    const existing = input.id ? this.getIntegration(input.id) : undefined
    const record: IntegrationRecord = existing
      ? {
          ...existing,
          platform: input.platform,
          name: input.name,
          token: input.token,
          groupId: input.groupId,
          status: input.status,
          stats: input.stats ?? existing.stats,
        }
      : {
          id: input.id ?? `int_${input.platform}_${randomUUID().slice(0, 8)}`,
          platform: input.platform,
          name: input.name,
          token: input.token,
          groupId: input.groupId,
          status: input.status,
          connectedAt: input.connectedAt ?? now,
          stats: input.stats ?? { totalPosts: 0, lastActivity: null },
        }
    if (existing) {
      this.data.integrations = this.data.integrations.map((i) =>
        i.id === record.id ? record : i,
      )
    } else {
      this.data.integrations.push(record)
    }
    await this.persist()
    return record
  }

  async deleteIntegration(id: string): Promise<boolean> {
    const before = this.data.integrations.length
    this.data.integrations = this.data.integrations.filter((i) => i.id !== id)
    this.data.flows = this.data.flows.filter(
      (f) => f.source.integrationId !== id && f.destination.integrationId !== id,
    )
    if (this.data.integrations.length === before) return false
    await this.persist()
    return true
  }

  getFlows(): FlowRecord[] {
    return [...this.data.flows]
  }

  getFlow(id: string): FlowRecord | undefined {
    return this.data.flows.find((f) => f.id === id)
  }

  async saveFlow(flow: FlowRecord): Promise<void> {
    const idx = this.data.flows.findIndex((f) => f.id === flow.id)
    if (idx >= 0) {
      this.data.flows[idx] = flow
    } else {
      this.data.flows.push(flow)
    }
    await this.persist()
  }

  async deleteFlow(id: string): Promise<boolean> {
    const before = this.data.flows.length
    this.data.flows = this.data.flows.filter((f) => f.id !== id)
    if (before === this.data.flows.length) return false
    await this.persist()
    return true
  }

  async updateFlowStats(
    id: string,
    patch: Partial<FlowStats> & { incrementForwarded?: number; incrementErrors?: number },
  ): Promise<void> {
    const flow = this.getFlow(id)
    if (!flow) return
    const stats = { ...flow.stats }
    if (patch.incrementForwarded) {
      stats.totalForwarded += patch.incrementForwarded
      stats.lastForwardedAt = new Date().toISOString()
    }
    if (patch.incrementErrors) {
      stats.errors += patch.incrementErrors
    }
    if (patch.totalForwarded !== undefined) stats.totalForwarded = patch.totalForwarded
    if (patch.lastForwardedAt !== undefined) stats.lastForwardedAt = patch.lastForwardedAt
    if (patch.errors !== undefined) stats.errors = patch.errors
    await this.saveFlow({ ...flow, stats })
  }

  async appendForwardedLog(entry: Omit<ForwardedLogEntry, 'id' | 'forwardedAt'>): Promise<void> {
    this.data.forwardedLog.unshift({
      ...entry,
      id: randomUUID(),
      forwardedAt: new Date().toISOString(),
    })
    if (this.data.forwardedLog.length > 500) {
      this.data.forwardedLog = this.data.forwardedLog.slice(0, 500)
    }
    await this.persist()
  }

  getForwardedLog(limit: number, flowId?: string): ForwardedLogEntry[] {
    let list = this.data.forwardedLog
    if (flowId) {
      list = list.filter((e) => e.flowId === flowId)
    }
    return list.slice(0, limit)
  }

  async setLinkedChats(
    integrationId: string,
    chats: PlatformChannelInfo[],
    options?: { keepExistingIfEmpty?: boolean },
  ): Promise<IntegrationRecord | undefined> {
    const integ = this.getIntegration(integrationId)
    if (!integ) return undefined
    if (options?.keepExistingIfEmpty && chats.length === 0 && (integ.linkedChats?.length ?? 0) > 0) {
      return integ
    }
    const linkedChats: IntegrationLinkedChat[] = chats.map((c) => ({
      id: c.id,
      title: c.title,
      username: c.username,
      type: c.type,
      botIsAdmin: c.botIsAdmin === true,
    }))
    const record: IntegrationRecord = {
      ...integ,
      linkedChats,
      linkedChatsUpdatedAt: new Date().toISOString(),
    }
    this.data.integrations = this.data.integrations.map((i) =>
      i.id === record.id ? record : i,
    )
    await this.persist()
    return record
  }

  getTelegramIntegration(): IntegrationRecord | undefined {
    return this.data.integrations.find(
      (i) => i.platform === 'telegram' && i.status === 'connected',
    )
  }

  async bumpIntegrationActivity(integrationId: string, posts = 1): Promise<void> {
    const integ = this.getIntegration(integrationId)
    if (!integ) return
    await this.upsertIntegration({
      ...integ,
      stats: {
        totalPosts: integ.stats.totalPosts + posts,
        lastActivity: new Date().toISOString(),
      },
    })
  }

  /** Удаляет потоки, у которых источник или назначение — этот MAX-канал. */
  async removeFlowsForMaxChatId(chatId: number): Promise<number> {
    await this.load()
    const targetAbs = Math.abs(chatId)
    const matches = (channelId: string | undefined): boolean => {
      if (!channelId) {
        return false
      }
      const parsed = Number.parseInt(channelId, 10)
      return Number.isFinite(parsed) && Math.abs(parsed) === targetAbs
    }
    const before = this.data.flows.length
    this.data.flows = this.data.flows.filter((f) => {
      const destHit = f.destination.platform === 'max' && matches(f.destination.channelId)
      const srcHit = f.source.platform === 'max' && matches(f.source.channelId)
      return !destHit && !srcHit
    })
    const removed = before - this.data.flows.length
    if (removed > 0) {
      this.data.forwardedLog = this.data.forwardedLog.filter((e) => {
        const flow = this.data.flows.find((f) => f.id === e.flowId)
        return flow !== undefined
      })
      await this.persist()
    }
    return removed
  }
}

export const integrationsStore = new IntegrationsStore()

export function maskToken(token: string): string {
  if (token.length <= 4) return '••••'
  return `••••••••${token.slice(-4)}`
}

/** Ответ для авторизованной админ-панели (маршруты с checkAdminAuth). */
export function integrationPublicView(i: IntegrationRecord): Record<string, unknown> {
  const connected = i.status === 'connected'
  const hasToken = i.token.trim().length > 0
  const linkedChats =
    i.platform === 'telegram' ? normalizeTelegramLinkedChatsForApi(i.linkedChats) : (i.linkedChats ?? [])
  return {
    id: i.id,
    platform: i.platform,
    name: i.name,
    groupId: i.groupId ?? null,
    status: i.status,
    connectedAt: i.connectedAt,
    stats: i.stats,
    hasToken,
    token: connected && hasToken ? i.token : '',
    tokenPreview: hasToken ? maskToken(i.token) : '',
    linkedChats,
    linkedChatsUpdatedAt: i.linkedChatsUpdatedAt ?? null,
  }
}
