import { randomUUID } from 'node:crypto'

import type { Bot } from '@maxhub/max-bot-api'
import express from 'express'

import { checkAdminAuth } from '../middleware/adminAuth'
import { config, getTelegramToken } from '../config'
import { logger } from '../utils/logger'
import { normalizeTelegramLinkedChatsForApi } from '../utils/telegramLinkedChats'
import { removeRootEnvVar, upsertRootEnvVar } from '../utils/envFile'
import { channelRegistry } from '../services/channelRegistry'
import {
  listMaxBotLinkedChannels,
  maxChannelAccessHint,
} from '../services/maxPlatformClient'
import { flowStateStore } from '../services/flowStateStore'
import { buildIntegrationsAnalytics, flowProcessor } from '../services/flowProcessor'
import {
  buildTelegramLinkedChatsList,
  listTelegramChatAdministrators,
  listVkGroups,
  telegramLinkedChatsSnapshotChanged,
  testIntegration,
} from '../services/integrationPlatformClient'
import {
  integrationPublicView,
  integrationsStore,
  type FlowFilters,
  type FlowRecord,
  type IntegrationPlatform,
  type IntegrationRecord,
} from '../services/integrationsStore'
import { syncTgChainBotTokensOnTelegramReconnect, repairStaleTgChainBotTokens } from '../services/tgChainChannelRef'
export interface IntegrationsRouterDeps {
  bot: Bot
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePlatform(value: unknown): IntegrationPlatform | null {
  return value === 'telegram' || value === 'vk' ? value : null
}

function parseKeywords(raw: unknown): string[] {
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  if (Array.isArray(raw)) {
    return raw.filter((k): k is string => typeof k === 'string' && k.trim() !== '')
  }
  return []
}

function parseFiltersBody(body: Record<string, unknown>): FlowFilters {
  return {
    keywords: parseKeywords(body.keywords),
    excludeKeywords: parseKeywords(body.excludeKeywords),
    mediaOnly: body.mediaOnly === true,
    delaySeconds:
      typeof body.delaySeconds === 'number' && Number.isFinite(body.delaySeconds)
        ? body.delaySeconds
        : 0,
  }
}

function buildFlowName(sourceLabel: string, destLabel: string): string {
  return `${sourceLabel} → ${destLabel}`
}

function wantsRefresh(query: express.Request['query']): boolean {
  const raw = query.refresh
  if (raw === '1' || raw === 'true') return true
  if (Array.isArray(raw) && (raw[0] === '1' || raw[0] === 'true')) return true
  return false
}

function parseQueryString(value: unknown): string | null {
  if (typeof value === 'string') {
    const t = value.trim()
    return t === '' ? null : t
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    const t = value[0].trim()
    return t === '' ? null : t
  }
  return null
}

/** Токен из integrations.json важнее устаревшего TG_TOKEN в .env. */
function telegramIntegrationToken(integ: IntegrationRecord): string {
  return (integ.token || getTelegramToken()).trim()
}

async function resolveTelegramLinkedChats(
  refresh: boolean,
): Promise<{
  integrationId: string | null
  channels: Awaited<ReturnType<typeof buildTelegramLinkedChatsList>>
  linkedChatsUpdatedAt: string | null
}> {
  await integrationsStore.load()
  const integ = integrationsStore.getTelegramIntegration()
  if (!integ) {
    return { integrationId: null, channels: [], linkedChatsUpdatedAt: null }
  }
  const token = telegramIntegrationToken(integ)
  const channels = await buildTelegramLinkedChatsList({
    integrationId: integ.id,
    token,
    existingLinkedChats: integ.linkedChats,
    refresh,
  })
  const shouldPersist =
    refresh || telegramLinkedChatsSnapshotChanged(integ.linkedChats, channels)
  if (shouldPersist) {
    await integrationsStore.setLinkedChats(integ.id, channels, {
      keepExistingIfEmpty: refresh && channels.length === 0,
    })
  }
  const updated = integrationsStore.getIntegration(integ.id)
  return {
    integrationId: integ.id,
    channels: updated?.linkedChats ?? channels,
    linkedChatsUpdatedAt: updated?.linkedChatsUpdatedAt ?? null,
  }
}

async function attachTelegramChatAdmins(
  token: string,
  channels: Awaited<ReturnType<typeof buildTelegramLinkedChatsList>>,
): Promise<
  Array<
    (typeof channels)[number] & {
      admins: Array<{
        user_id: number
        name: string
        username?: string
        is_creator: boolean
        started_bot: boolean
      }>
      startedAdminCount: number
    }
  >
> {
  const out: Array<
    (typeof channels)[number] & {
      admins: Array<{
        user_id: number
        name: string
        username?: string
        is_creator: boolean
        started_bot: boolean
      }>
      startedAdminCount: number
    }
  > = []
  for (const ch of channels) {
    const tgAdmins = await listTelegramChatAdministrators(token, ch.id)
    const admins = tgAdmins.map((a) => ({
      user_id: a.userId,
      name: a.name,
      username: a.username,
      is_creator: a.isCreator,
      started_bot: a.startedBot,
    }))
    const startedAdminCount = admins.filter((a) => a.started_bot).length
    out.push({
      ...ch,
      admins,
      startedAdminCount,
    })
  }
  return out
}

export function createIntegrationsRouter(deps: IntegrationsRouterDeps): express.Router {
  const router = express.Router()
  router.use(express.json({ limit: '256kb' }))
  router.use(checkAdminAuth)

  router.get('/', async (_req, res) => {
    await integrationsStore.load()
    res.json({
      integrations: integrationsStore.getIntegrations().map(integrationPublicView),
    })
  })

  router.get('/telegram/linked-chats', async (req, res) => {
    try {
      const { integrationId, channels, linkedChatsUpdatedAt } = await resolveTelegramLinkedChats(
        wantsRefresh(req.query),
      )
      const integ = integrationId ? integrationsStore.getIntegration(integrationId) : null
      const token = integ ? telegramIntegrationToken(integ) : ''
      const channelsWithAdmins =
        integ && token
          ? await attachTelegramChatAdmins(token, channels)
          : normalizeTelegramLinkedChatsForApi(channels).map((ch) => ({
              ...ch,
              admins: [],
              startedAdminCount: 0,
            }))
      const adminCount = channelsWithAdmins.filter((c) => c.botIsAdmin === true).length
      res.json({
        connected: integrationId !== null,
        integrationId,
        channels: normalizeTelegramLinkedChatsForApi(channelsWithAdmins),
        linkedChatsUpdatedAt,
        adminCount,
        hint:
          channels.length === 0
            ? 'Добавьте бота администратором в канал/группу и отправьте туда сообщение, затем нажмите «Обновить».'
            : adminCount === 0
              ? 'Чаты найдены, но бот нигде не администратор. Выдайте боту права админа и нажмите «Обновить».'
              : null,
      })
    } catch (err: unknown) {
      logger.error('GET /telegram/linked-chats failed', err)
      res.status(500).json({ error: 'Не удалось получить список чатов Telegram' })
    }
  })

  router.get('/telegram/channel-admins', async (req, res) => {
    try {
      await integrationsStore.load()
      const integ = integrationsStore.getTelegramIntegration()
      if (!integ) {
        res.status(404).json({ error: 'Telegram интеграция не подключена' })
        return
      }
      const chatId = parseQueryString(req.query.chatId ?? req.query.chat_id)
      if (!chatId) {
        res.status(400).json({ error: 'chatId обязателен' })
        return
      }
      const token = telegramIntegrationToken(integ)
      const admins = await listTelegramChatAdministrators(token, chatId)
      res.json({
        connected: true,
        integrationId: integ.id,
        chatId,
        admins: admins.map((a) => ({
          user_id: a.userId,
          name: a.name,
          username: a.username,
          is_creator: a.isCreator,
          started_bot: a.startedBot,
        })),
        startedAdminCount: admins.filter((a) => a.startedBot).length,
      })
    } catch (err: unknown) {
      logger.error('GET /telegram/channel-admins failed', err)
      res.status(500).json({ error: 'Не удалось получить список администраторов Telegram-канала' })
    }
  })

  router.get('/meta/max', (_req, res) => {
    const channels = channelRegistry
      .getAllChannels()
      .filter((c) => c.type === 'channel')
      .map((c) => ({ id: String(c.chat_id), title: c.title ?? String(c.chat_id) }))
    res.json({
      channelCount: channels.length,
      tokenPreview: config.BOT_TOKEN.slice(-4),
      channels,
    })
  })

  router.get('/max/linked-channels', async (req, res) => {
    try {
      const refresh = wantsRefresh(req.query)
      const channels = await listMaxBotLinkedChannels(deps.bot, {
        syncRegistry: refresh,
        liveCheck: true,
      })
      const adminCount = channels.filter((c) => c.botIsAdmin).length
      res.json({
        connected: true,
        channels,
        channelCount: channels.length,
        adminCount,
        tokenPreview: config.BOT_TOKEN.slice(-4),
        refreshedAt: new Date().toISOString(),
        hint: maxChannelAccessHint(channels),
      })
    } catch (err: unknown) {
      logger.error('GET /max/linked-channels failed', err)
      res.status(500).json({ error: 'Не удалось получить список каналов MAX' })
    }
  })

  router.post('/connect', async (req, res) => {
    const body = req.body as unknown
    if (!isRecord(body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    const platform = parsePlatform(body.platform)
    const tokenRaw = typeof body.token === 'string' ? body.token.trim() : ''
    if (!platform) {
      res.status(400).json({ error: 'platform required' })
      return
    }
    await integrationsStore.load()
    const existingForPlatform = integrationsStore
      .getIntegrations()
      .find((i) => i.platform === platform)
    const token = tokenRaw !== '' ? tokenRaw : (existingForPlatform?.token ?? '').trim()
    if (token === '') {
      res.status(400).json({ error: 'Укажите токен бота' })
      return
    }
    const name =
      typeof body.name === 'string' && body.name.trim() !== ''
        ? body.name.trim()
        : platform === 'telegram'
          ? 'Telegram Bot'
          : 'VK'
    const groupId =
      typeof body.groupId === 'string' && body.groupId.trim() !== ''
        ? body.groupId.trim()
        : undefined

    const test = await testIntegration(platform, token, groupId)
    if (!test.ok) {
      res.status(400).json({ error: test.error ?? 'connection failed' })
      return
    }

    const existing = existingForPlatform
    const record = await integrationsStore.upsertIntegration({
      id: existing?.id,
      platform,
      name: test.info ?? name,
      token,
      groupId,
      status: 'connected',
    })

    if (platform === 'telegram') {
      process.env.TG_TOKEN = token
      try {
        await upsertRootEnvVar('TG_TOKEN', token)
      } catch (err: unknown) {
        // Токен уже в integrations.json; в Docker .env часто не на volume.
        logger.warn('integrations: TG_TOKEN не записан в .env (токен сохранён в integrations.json)', err)
      }
      const previousToken = existingForPlatform?.token?.trim() ?? ''
      const chainsUpdated = await syncTgChainBotTokensOnTelegramReconnect(previousToken, token)
      const staleRepaired = await repairStaleTgChainBotTokens()
      if (chainsUpdated > 0 || staleRepaired.repaired > 0) {
        logger.info('integrations: tg chain bot_token synced after reconnect', {
          chainsUpdated,
          staleRepaired: staleRepaired.repaired,
        })
      }
    }

    let channels: Awaited<ReturnType<typeof buildTelegramLinkedChatsList>> = []
    if (platform === 'telegram') {
      channels = await buildTelegramLinkedChatsList({
        integrationId: record.id,
        token,
        existingLinkedChats: record.linkedChats,
        refresh: true,
      })
      await integrationsStore.setLinkedChats(record.id, channels)
    }

    const updated = integrationsStore.getIntegration(record.id) ?? record
    res.json({
      ok: true,
      integration: integrationPublicView(updated),
      channels,
      hint:
        platform === 'telegram' && channels.length === 0
          ? 'Бот подключён. Добавьте его в канал/чат как администратора и отправьте сообщение — затем обновите список.'
          : null,
    })
  })

  router.delete('/:id', async (req, res) => {
    await integrationsStore.load()
    const removed = integrationsStore.getIntegration(req.params.id)
    const ok = await integrationsStore.deleteIntegration(req.params.id)
    if (!ok) {
      res.status(404).json({ error: 'not found' })
      return
    }
    if (removed?.platform === 'telegram') {
      try {
        await removeRootEnvVar('TG_TOKEN')
      } catch (err: unknown) {
        logger.warn('integrations: failed to remove TG_TOKEN from .env', err)
      }
    }
    await flowProcessor.reload()
    res.json({ ok: true })
  })

  router.post('/:id/test', async (req, res) => {
    await integrationsStore.load()
    const integ = integrationsStore.getIntegration(req.params.id)
    if (!integ) {
      res.status(404).json({ error: 'not found' })
      return
    }
    const token = integ.platform === 'telegram' ? telegramIntegrationToken(integ) : integ.token
    const result = await testIntegration(integ.platform, token, integ.groupId)
    res.json(result)
  })

  router.get('/:id/channels', async (req, res) => {
    await integrationsStore.load()
    const integ = integrationsStore.getIntegration(req.params.id)
    if (!integ) {
      res.status(404).json({ error: 'not found' })
      return
    }
    const refresh = wantsRefresh(req.query)
    const token = integ.platform === 'telegram' ? telegramIntegrationToken(integ) : integ.token

    if (integ.platform === 'telegram') {
      const channels = await buildTelegramLinkedChatsList({
        integrationId: integ.id,
        token,
        existingLinkedChats: integ.linkedChats,
        refresh,
      })
      const shouldPersist =
        refresh || telegramLinkedChatsSnapshotChanged(integ.linkedChats, channels)
      if (shouldPersist) {
        await integrationsStore.setLinkedChats(integ.id, channels, {
          keepExistingIfEmpty: refresh && channels.length === 0,
        })
      }
      const updated = integrationsStore.getIntegration(integ.id)
      const channelsForResponse = updated?.linkedChats ?? channels
      const channelsWithAdmins = await attachTelegramChatAdmins(token, channelsForResponse)
      res.json({
        channels: channelsWithAdmins,
        linkedChatsUpdatedAt: updated?.linkedChatsUpdatedAt ?? null,
        adminCount: channelsWithAdmins.filter((c) => c.botIsAdmin === true).length,
      })
      return
    }

    const channels = await listVkGroups(token, integ.groupId)
    res.json({ channels })
  })

  return router
}

export function createFlowsRouter(_deps: IntegrationsRouterDeps): express.Router {
  const router = express.Router()
  router.use(express.json({ limit: '256kb' }))
  router.use(checkAdminAuth)

  router.get('/log', async (req, res) => {
    await integrationsStore.load()
    const limitRaw = req.query.limit
    const limit =
      typeof limitRaw === 'string' ? Math.min(100, Math.max(1, Number(limitRaw) || 50)) : 50
    const flowId = typeof req.query.flowId === 'string' ? req.query.flowId : undefined
    res.json({ items: integrationsStore.getForwardedLog(limit, flowId) })
  })

  router.get('/', async (_req, res) => {
    await integrationsStore.load()
    res.json({ flows: integrationsStore.getFlows() })
  })

  router.post('/', async (req, res) => {
    const body = req.body as unknown
    if (!isRecord(body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    await integrationsStore.load()

    const source = body.source
    const destination = body.destination
    if (!isRecord(source) || !isRecord(destination)) {
      res.status(400).json({ error: 'source and destination required' })
      return
    }

    const integrationId =
      typeof source.integrationId === 'string' ? source.integrationId : ''
    const integ = integrationsStore.getIntegration(integrationId)
    if (!integ) {
      res.status(400).json({ error: 'integration not found' })
      return
    }

    const sourcePlatform = source.platform
    const destPlatform = destination.platform
    if (
      sourcePlatform !== 'telegram' &&
      sourcePlatform !== 'vk' &&
      sourcePlatform !== 'max'
    ) {
      res.status(400).json({ error: 'invalid source platform' })
      return
    }
    if (
      destPlatform !== 'telegram' &&
      destPlatform !== 'vk' &&
      destPlatform !== 'max'
    ) {
      res.status(400).json({ error: 'invalid destination platform' })
      return
    }

    const channelId =
      typeof destination.channelId === 'string' ? destination.channelId : ''
    if (channelId === '') {
      res.status(400).json({ error: 'destination.channelId required' })
      return
    }

    const sourceLabel =
      typeof source.channelUsername === 'string'
        ? source.channelUsername
        : typeof source.channelId === 'string'
          ? source.channelId
          : sourcePlatform
    const destTitle =
      destPlatform === 'max'
        ? channelRegistry.getChannel(Number(channelId))?.title ?? channelId
        : channelId

    const name =
      typeof body.name === 'string' && body.name.trim() !== ''
        ? body.name.trim()
        : buildFlowName(sourceLabel, destTitle)

    const flow: FlowRecord = {
      id: `flow_${randomUUID().slice(0, 8)}`,
      name,
      enabled: body.enabled !== false,
      source: {
        integrationId,
        platform: sourcePlatform,
        channelUsername:
          typeof source.channelUsername === 'string' ? source.channelUsername : undefined,
        channelId: typeof source.channelId === 'string' ? source.channelId : undefined,
        contentTypes: Array.isArray(source.contentTypes)
          ? source.contentTypes.filter((c): c is string => typeof c === 'string')
          : undefined,
      },
      filters: parseFiltersBody(isRecord(body.filters) ? body.filters : {}),
      destination: {
        platform: destPlatform,
        channelId,
        integrationId:
          typeof destination.integrationId === 'string'
            ? destination.integrationId
            : undefined,
        addCommentsButton: destination.addCommentsButton === true,
        signature:
          typeof destination.signature === 'string' ? destination.signature : undefined,
      },
      stats: { totalForwarded: 0, lastForwardedAt: null, errors: 0 },
      createdAt: new Date().toISOString(),
    }

    await integrationsStore.saveFlow(flow)
    if (flow.enabled) {
      flowProcessor.startFlowPoller(flow)
    }
    res.status(201).json({ flow })
  })

  router.put('/:id', async (req, res) => {
    await integrationsStore.load()
    const existing = integrationsStore.getFlow(req.params.id)
    if (!existing) {
      res.status(404).json({ error: 'not found' })
      return
    }
    const body = req.body as unknown
    if (!isRecord(body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }

    const flow: FlowRecord = {
      ...existing,
      name: typeof body.name === 'string' ? body.name : existing.name,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : existing.enabled,
      source: isRecord(body.source)
        ? {
            ...existing.source,
            channelUsername:
              typeof body.source.channelUsername === 'string'
                ? body.source.channelUsername
                : existing.source.channelUsername,
            channelId:
              typeof body.source.channelId === 'string'
                ? body.source.channelId
                : existing.source.channelId,
          }
        : existing.source,
      filters: isRecord(body.filters)
        ? parseFiltersBody(body.filters)
        : existing.filters,
      destination: isRecord(body.destination)
        ? {
            ...existing.destination,
            channelId:
              typeof body.destination.channelId === 'string'
                ? body.destination.channelId
                : existing.destination.channelId,
            addCommentsButton:
              typeof body.destination.addCommentsButton === 'boolean'
                ? body.destination.addCommentsButton
                : existing.destination.addCommentsButton,
            signature:
              typeof body.destination.signature === 'string'
                ? body.destination.signature
                : existing.destination.signature,
          }
        : existing.destination,
    }

    await integrationsStore.saveFlow(flow)
    flowProcessor.stopFlowPoller(flow.id)
    if (flow.enabled) {
      flowProcessor.startFlowPoller(flow)
    }
    res.json({ flow })
  })

  router.delete('/:id', async (req, res) => {
    await integrationsStore.load()
    flowProcessor.stopFlowPoller(req.params.id)
    const ok = await integrationsStore.deleteFlow(req.params.id)
    if (!ok) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json({ ok: true })
  })

  router.patch('/:id/toggle', async (req, res) => {
    await integrationsStore.load()
    const flow = integrationsStore.getFlow(req.params.id)
    if (!flow) {
      res.status(404).json({ error: 'not found' })
      return
    }
    const body = req.body as unknown
    const enabled =
      isRecord(body) && typeof body.enabled === 'boolean'
        ? body.enabled
        : !flow.enabled
    const updated = { ...flow, enabled }
    await integrationsStore.saveFlow(updated)
    if (enabled) {
      flowProcessor.startFlowPoller(updated)
    } else {
      flowProcessor.stopFlowPoller(updated.id)
    }
    res.json({ flow: updated })
  })

  router.get('/:id/status', async (req, res) => {
    await integrationsStore.load()
    await flowStateStore.load()
    const flow = integrationsStore.getFlow(req.params.id)
    if (!flow) {
      res.status(404).json({ error: 'not found' })
      return
    }
    const cursor = flowStateStore.getCursorMeta(flow.id)
    const recentActivity = integrationsStore.getForwardedLog(5, flow.id)
    res.json({
      flowId: flow.id,
      enabled: flow.enabled,
      source: `${flow.source.platform}:${flow.source.channelUsername ?? flow.source.channelId ?? '?'}`,
      destination: `${flow.destination.platform}:${flow.destination.channelId}`,
      cursor: {
        lastMessageId: cursor.lastMessageId,
        updatedAt: cursor.updatedAt,
      },
      stats: flow.stats,
      recentActivity,
    })
  })

  router.post('/:id/test', async (req, res) => {
    await integrationsStore.load()
    const flow = integrationsStore.getFlow(req.params.id)
    if (!flow) {
      res.status(404).json({ error: 'not found' })
      return
    }
    try {
      const result = await flowProcessor.runFlowOnce(flow.id)
      res.json({
        ok: true,
        fetchedPosts: result.fetchedPosts,
        filtered: result.filtered,
        forwarded: result.forwarded,
        cursorBefore: result.cursorBefore,
        cursorAfter: result.lastMessageId,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'flow test failed'
      res.json({ ok: false, error: message })
    }
  })

  router.get('/:id/stats', async (req, res) => {
    await integrationsStore.load()
    const flow = integrationsStore.getFlow(req.params.id)
    if (!flow) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json(flow.stats)
  })

  return router
}

export function createIntegrationsAnalyticsRouter(): express.Router {
  const router = express.Router()
  router.use(checkAdminAuth)
  router.get('/', async (_req, res) => {
    await integrationsStore.load()
    res.json(buildIntegrationsAnalytics())
  })
  return router
}
