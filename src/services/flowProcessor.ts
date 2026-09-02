import type { Bot } from '@maxhub/max-bot-api'

import { listTgChainsSync } from '../api/adminPanelState'
import { config, getFlowPollIntervalMs, getTelegramToken } from '../config'
import { findActiveTgChainForPair } from '../utils/tgChainPair'
import { channelRegistry } from './channelRegistry'
import {
  fetchTelegramChannelPosts,
  fetchVkWallPosts,
  mergePlatformChannels,
  publishVkWallPost,
  type ExternalPost,
} from './integrationPlatformClient'
import { flowStateStore } from './flowStateStore'
import {
  integrationsStore,
  type FlowDestination,
  type FlowFilters,
  type FlowRecord,
} from './integrationsStore'
import { logger } from '../utils/logger'
import { sendAdminAlert } from '../utils/alertService'

function flowPollMs(): number {
  return getFlowPollIntervalMs()
}

export interface FlowTickResult {
  fetchedPosts: number
  filtered: number
  forwarded: number
  cursorBefore: number
  lastMessageId: number
}

interface FetchFlowPostsResult {
  posts: ExternalPost[]
  lastMessageId: number
  cursorBefore: number
}

export class FlowProcessor {
  private bot: Bot | null = null
  private pollers = new Map<string, NodeJS.Timeout>()
  private flowInFlight = new Set<string>()
  private started = false
  private emptyTickCount = new Map<string, number>()
  /** Однократное предупреждение: поток TG→MAX дублирует активную связку. */
  private supersededByTgChainLogged = new Set<string>()

  setBot(bot: Bot): void {
    this.bot = bot
  }

  async start(): Promise<void> {
    if (this.started) return
    await integrationsStore.load()
    await flowStateStore.load()
    const flows = integrationsStore.getFlows().filter((f) => f.enabled)
    for (const flow of flows) {
      this.startFlowPoller(flow)
    }
    this.started = true
    logger.info('flowProcessor: started', {
      flowCount: flows.length,
      pollIntervalMs: flowPollMs(),
    })
    if (flows.length === 0) {
      logger.warn(
        'flowProcessor: нет активных потоков (TG→MAX). Подключите Telegram в /admin → Интеграции и создайте поток; данные: data/integrations.json',
      )
    }
  }

  async reload(): Promise<void> {
    this.stopPollers()
    await integrationsStore.reloadFromDisk()
    await flowStateStore.load()
    const flows = integrationsStore.getFlows().filter((f) => f.enabled)
    for (const flow of flows) {
      this.startFlowPoller(flow)
    }
    logger.info('flowProcessor: reloaded', { flowCount: flows.length })
  }

  startFlowPoller(flow: FlowRecord): void {
    if (this.pollers.has(flow.id)) return
    const interval = setInterval(() => {
      void this.processFlowSafe(flow.id)
    }, flowPollMs())
    this.pollers.set(flow.id, interval)
    void this.processFlowSafe(flow.id)
  }

  private async processFlowSafe(flowId: string): Promise<void> {
    if (this.flowInFlight.has(flowId)) {
      return
    }
    this.flowInFlight.add(flowId)
    try {
      const flow = integrationsStore.getFlow(flowId)
      if (!flow || !flow.enabled) return
      if (this.isFlowSupersededByTgChain(flow)) {
        if (!this.supersededByTgChainLogged.has(flow.id)) {
          this.supersededByTgChainLogged.add(flow.id)
          logger.warn(
            'flowProcessor: поток TG→MAX пропущен — та же пара уже обслуживается tgChainForwarder (связка в админке). Отключите поток в Интеграциях или связку, чтобы не дублировать.',
            {
              flowId: flow.id,
              flowName: flow.name,
              source: flow.source.channelUsername ?? flow.source.channelId,
              destination: flow.destination.channelId,
            },
          )
        }
        return
      }
      try {
        await this.processFlow(flow)
      } catch (err: unknown) {
        logger.error('flowProcessor: error', { flowId: flow.id, err })
        await integrationsStore.updateFlowStats(flow.id, { incrementErrors: 1 })
        await sendAdminAlert(
          `flow_error:${flow.id}`,
          'Сбой потока переноса постов — публикация может быть остановлена',
          {
            flowId: flow.id,
            flowName: flow.name,
            error: err instanceof Error ? err.message : String(err),
          },
        )
      }
    } finally {
      this.flowInFlight.delete(flowId)
    }
  }

  /** Активная связка TG→MAX с forward_posts покрывает тот же маршрут, что и legacy-поток. */
  private isFlowSupersededByTgChain(flow: FlowRecord): boolean {
    if (flow.source.platform !== 'telegram' || flow.destination.platform !== 'max') {
      return false
    }
    const maxChatId = Number(flow.destination.channelId)
    if (!Number.isFinite(maxChatId)) {
      return false
    }
    const tgChannelId = flow.source.channelId ?? ''
    const tgUsername = flow.source.channelUsername ?? ''
    const chains = listTgChainsSync().filter((c) => c.active !== false && c.forward_posts)
    return findActiveTgChainForPair(chains, maxChatId, tgChannelId, tgUsername) !== null
  }

  stopFlowPoller(flowId: string): void {
    const t = this.pollers.get(flowId)
    if (t) {
      clearInterval(t)
      this.pollers.delete(flowId)
    }
  }

  stop(): void {
    this.stopPollers()
    this.started = false
    logger.info('flowProcessor: stopped')
  }

  private stopPollers(): void {
    for (const timer of this.pollers.values()) clearInterval(timer)
    this.pollers.clear()
    this.flowInFlight.clear()
  }

  async runFlowOnce(flowId: string): Promise<FlowTickResult> {
    await integrationsStore.load()
    await flowStateStore.load()
    const flow = integrationsStore.getFlow(flowId)
    if (!flow) {
      throw new Error('flow not found')
    }
    return this.processFlow(flow)
  }

  private async processFlow(flow: FlowRecord): Promise<FlowTickResult> {
    const tickStart = Date.now()
    const sourceLabel = `${flow.source.platform}:${flow.source.channelUsername ?? flow.source.channelId ?? '?'}`
    const destLabel = `${flow.destination.platform}:${flow.destination.channelId}`

    const { posts, lastMessageId, cursorBefore } = await this.fetchNewPosts(flow)

    logger.info('flowProcessor: tick', {
      flowId: flow.id,
      source: sourceLabel,
      dest: destLabel,
      fetchedPosts: posts.length,
      cursorBefore,
      cursorAfter: lastMessageId,
    })

    if (!posts.length) {
      const count = (this.emptyTickCount.get(flow.id) ?? 0) + 1
      this.emptyTickCount.set(flow.id, count)
      if (count === 5) {
        logger.warn('flowProcessor: 5 empty ticks in a row', {
          flowId: flow.id,
          hint:
            'Бот должен быть в канале/группе. Для канала — пост от админа; для группы — обычное сообщение. Проверьте @username/-100 ID в потоке и что у TG-бота нет webhook (deleteWebhook).',
        })
      }
      return {
        fetchedPosts: 0,
        filtered: 0,
        forwarded: 0,
        cursorBefore,
        lastMessageId,
      }
    }

    this.emptyTickCount.delete(flow.id)

    const filtered = posts.filter((p) => this.applyFilters(p, flow.filters))

    logger.info('flowProcessor: after filters', {
      flowId: flow.id,
      total: posts.length,
      passed: filtered.length,
      dropped: posts.length - filtered.length,
    })

    let forwarded = 0
    for (const post of filtered) {
      if (flow.filters.delaySeconds > 0) {
        const readyAt = Date.now() + flow.filters.delaySeconds * 1000
        await flowStateStore.scheduleDelayedPost(flow.id, post.externalId, readyAt)
        continue
      }
      try {
        await this.forwardPost(flow, post)
        forwarded += 1
        logger.info('flowProcessor: forwarded', {
          flowId: flow.id,
          postId: post.externalId,
          from: flow.source.channelUsername ?? flow.source.channelId,
          to: flow.destination.channelId,
          ms: Date.now() - tickStart,
        })
      } catch (err: unknown) {
        logger.error('flowProcessor: send failed', {
          flowId: flow.id,
          postId: post.externalId,
          err,
        })
        await integrationsStore.updateFlowStats(flow.id, { incrementErrors: 1 })
      }
    }

    const readyIds = flowStateStore.popReadyDelayedPosts(flow.id, Date.now())
    for (const postId of readyIds) {
      const post = posts.find((p) => p.externalId === postId)
      if (post && this.applyFilters(post, flow.filters)) {
        try {
          await this.forwardPost(flow, post)
          forwarded += 1
          logger.info('flowProcessor: forwarded', {
            flowId: flow.id,
            postId: post.externalId,
            from: flow.source.channelUsername ?? flow.source.channelId,
            to: flow.destination.channelId,
            delayed: true,
            ms: Date.now() - tickStart,
          })
        } catch (err: unknown) {
          logger.error('flowProcessor: send failed', {
            flowId: flow.id,
            postId: post.externalId,
            err,
          })
          await integrationsStore.updateFlowStats(flow.id, { incrementErrors: 1 })
        }
      }
    }

    return {
      fetchedPosts: posts.length,
      filtered: filtered.length,
      forwarded,
      cursorBefore,
      lastMessageId,
    }
  }

  private async forwardPost(flow: FlowRecord, post: ExternalPost): Promise<void> {
    await this.sendToDestination(post, flow)
    await integrationsStore.updateFlowStats(flow.id, { incrementForwarded: 1 })
    await integrationsStore.bumpIntegrationActivity(flow.source.integrationId)

    const fromChannel =
      flow.source.channelUsername ?? flow.source.channelId ?? flow.source.platform
    const destChannel = flow.destination.channelId
    const destTitle =
      channelRegistry.getChannel(Number(destChannel))?.title ?? destChannel

    await integrationsStore.appendForwardedLog({
      flowId: flow.id,
      fromPlatform: flow.source.platform,
      fromChannel,
      toPlatform: flow.destination.platform,
      toChannel: destTitle ?? destChannel,
      preview: post.text.slice(0, 120) || '(без текста)',
    })
  }

  private async fetchNewPosts(flow: FlowRecord): Promise<FetchFlowPostsResult> {
    const cursorBefore = flowStateStore.getLastMessageId(flow.id)
    const integ = integrationsStore.getIntegration(flow.source.integrationId)
    if (!integ || integ.status !== 'connected') {
      return { posts: [], lastMessageId: cursorBefore, cursorBefore }
    }

    if (flow.source.platform === 'telegram') {
      const tgToken = (integ.token || getTelegramToken()).trim()
      if (!tgToken) return { posts: [], lastMessageId: cursorBefore, cursorBefore }
      const channelKey = flow.source.channelId ?? flow.source.channelUsername ?? ''
      const { posts, lastMessageId, discoveredChats } = await fetchTelegramChannelPosts(
        tgToken,
        flow.source.integrationId,
        channelKey,
        cursorBefore,
      )
      if (lastMessageId > cursorBefore) {
        await flowStateStore.setLastMessageId(flow.id, lastMessageId)
      }
      // Merge bot-became-admin events captured inline so new channels appear
      // in linkedChats without waiting for the next manual refresh.
      if (discoveredChats.length > 0) {
        const existing = integ.linkedChats ?? []
        const merged = mergePlatformChannels(existing, discoveredChats)
        await integrationsStore.setLinkedChats(flow.source.integrationId, merged)
        logger.info('flowProcessor: обнаружены новые каналы (my_chat_member)', {
          flowId: flow.id,
          newChannels: discoveredChats.map((c) => ({ id: c.id, title: c.title })),
        })
      }
      return { posts, lastMessageId, cursorBefore }
    }

    if (flow.source.platform === 'vk') {
      const groupKey = flow.source.channelId ?? integ.groupId ?? ''
      const { posts, lastPostId } = await fetchVkWallPosts(integ.token, groupKey, cursorBefore)
      if (lastPostId > cursorBefore) {
        await flowStateStore.setLastMessageId(flow.id, lastPostId)
      }
      return { posts, lastMessageId: lastPostId, cursorBefore }
    }

    return { posts: [], lastMessageId: cursorBefore, cursorBefore }
  }

  private async sendToDestination(post: ExternalPost, flow: FlowRecord): Promise<void> {
    const dest = flow.destination
    let text = post.text
    if (dest.signature && dest.signature.trim() !== '') {
      text = text ? `${text}\n\n${dest.signature}` : dest.signature
    }
    if (!text) text = ' '

    if (dest.platform === 'max') {
      if (!this.bot) {
        throw new Error('MAX bot not initialized')
      }
      const chatId = Number(dest.channelId)
      if (!Number.isFinite(chatId)) {
        throw new Error('Invalid MAX channel id')
      }
      await this.bot.api.sendMessageToChat(chatId, text)
      return
    }

    if (dest.platform === 'vk') {
      const integId = dest.integrationId ?? flow.source.integrationId
      const integ = integrationsStore.getIntegration(integId)
      if (!integ) throw new Error('VK integration not found')
      const groupId = dest.channelId || integ.groupId || ''
      await publishVkWallPost(integ.token, groupId, text)
      return
    }

    if (dest.platform === 'telegram') {
      logger.warn('flowProcessor: telegram destination not implemented yet', {
        flowId: flow.id,
      })
    }
  }

  private applyFilters(post: ExternalPost, filters: FlowFilters): boolean {
    const lower = post.text.toLowerCase()
    if (filters.keywords.length > 0) {
      const hasKeyword = filters.keywords.some((kw) => lower.includes(kw.toLowerCase()))
      if (!hasKeyword) return false
    }
    if (filters.excludeKeywords.length > 0) {
      const hasExcluded = filters.excludeKeywords.some((kw) =>
        lower.includes(kw.toLowerCase()),
      )
      if (hasExcluded) return false
    }
    if (filters.mediaOnly && !post.hasMedia) return false
    return true
  }
}

export const flowProcessor = new FlowProcessor()

/** Сводная аналитика для панели */
export function buildIntegrationsAnalytics(): {
  telegram: { connected: boolean; totalPosts: number; forwarded: number; channels: number }
  vk: { connected: boolean; totalPosts: number; forwarded: number; channels: number }
  maxChannels: number
  maxTokenPreview: string
} {
  const integrations = integrationsStore.getIntegrations()
  const flows = integrationsStore.getFlows()
  const tg = integrations.find((i) => i.platform === 'telegram' && i.status === 'connected')
  const vk = integrations.find((i) => i.platform === 'vk' && i.status === 'connected')
  const tgFlows = flows.filter((f) => f.source.platform === 'telegram')
  const vkFlows = flows.filter((f) => f.source.platform === 'vk')
  const forwardedTg = tgFlows.reduce((s, f) => s + f.stats.totalForwarded, 0)
  const forwardedVk = vkFlows.reduce((s, f) => s + f.stats.totalForwarded, 0)

  return {
    telegram: {
      connected: !!tg,
      totalPosts: tg?.stats.totalPosts ?? 0,
      forwarded: forwardedTg,
      channels: tgFlows.length,
    },
    vk: {
      connected: !!vk,
      totalPosts: vk?.stats.totalPosts ?? 0,
      forwarded: forwardedVk,
      channels: vkFlows.length,
    },
    maxChannels: channelRegistry.getAllChannels().filter((c) => c.type === 'channel').length,
    maxTokenPreview: config.BOT_TOKEN.slice(-4),
  }
}
