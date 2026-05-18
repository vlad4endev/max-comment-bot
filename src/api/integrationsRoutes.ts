import { randomUUID } from 'node:crypto'

import type { Bot } from '@maxhub/max-bot-api'
import express from 'express'

import { checkAdminAuth } from '../middleware/adminAuth'
import { config, getTelegramToken } from '../config'
import { logger } from '../utils/logger'
import { removeRootEnvVar, upsertRootEnvVar } from '../utils/envFile'
import { channelRegistry } from '../services/channelRegistry'
import { buildIntegrationsAnalytics, flowProcessor } from '../services/flowProcessor'
import {
  listTelegramAdminChannels,
  listVkGroups,
  testIntegration,
} from '../services/integrationPlatformClient'
import {
  integrationPublicView,
  integrationsStore,
  type FlowFilters,
  type FlowRecord,
  type IntegrationPlatform,
} from '../services/integrationsStore'
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

  router.post('/connect', async (req, res) => {
    const body = req.body as unknown
    if (!isRecord(body)) {
      res.status(400).json({ error: 'invalid body' })
      return
    }
    const platform = parsePlatform(body.platform)
    const token = typeof body.token === 'string' ? body.token.trim() : ''
    if (!platform || token === '') {
      res.status(400).json({ error: 'platform and token required' })
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

    await integrationsStore.load()
    const existing = integrationsStore
      .getIntegrations()
      .find((i) => i.platform === platform)
    const record = await integrationsStore.upsertIntegration({
      id: existing?.id,
      platform,
      name: test.info ?? name,
      token,
      groupId,
      status: 'connected',
    })

    if (platform === 'telegram') {
      try {
        await upsertRootEnvVar('TG_TOKEN', token)
      } catch (err: unknown) {
        logger.error('integrations: failed to sync TG_TOKEN to .env', err)
        res.status(500).json({ error: 'Не удалось сохранить TG_TOKEN в .env' })
        return
      }
    }

    res.json({ ok: true, integration: integrationPublicView(record) })
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
    const token =
      integ.platform === 'telegram' ? getTelegramToken() || integ.token : integ.token
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
    const token =
      integ.platform === 'telegram' ? getTelegramToken() || integ.token : integ.token
    const channels =
      integ.platform === 'telegram'
        ? await listTelegramAdminChannels(token)
        : await listVkGroups(token, integ.groupId)
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
