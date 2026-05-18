import type { Bot } from '@maxhub/max-bot-api'

import { config, getTelegramToken } from '../config'
import { channelRegistry } from './channelRegistry'
import {
  fetchTelegramChannelPosts,
  fetchVkWallPosts,
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

const POLL_MS = 60_000

export class FlowProcessor {
  private bot: Bot | null = null
  private pollers = new Map<string, NodeJS.Timeout>()
  private started = false

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
    logger.info('flowProcessor: started', { flowCount: flows.length })
  }

  async reload(): Promise<void> {
    this.stopPollers()
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
    }, POLL_MS)
    this.pollers.set(flow.id, interval)
    void this.processFlowSafe(flow.id)
  }

  private async processFlowSafe(flowId: string): Promise<void> {
    const flow = integrationsStore.getFlow(flowId)
    if (!flow || !flow.enabled) return
    try {
      await this.processFlow(flow)
    } catch (err: unknown) {
      logger.error('flowProcessor: error', { flowId: flow.id, err })
      await integrationsStore.updateFlowStats(flow.id, { incrementErrors: 1 })
    }
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
  }

  private async processFlow(flow: FlowRecord): Promise<void> {
    const posts = await this.fetchNewPosts(flow)
    if (!posts.length) return

    const filtered = posts.filter((p) => this.applyFilters(p, flow.filters))
    for (const post of filtered) {
      if (flow.filters.delaySeconds > 0) {
        const readyAt = Date.now() + flow.filters.delaySeconds * 1000
        await flowStateStore.scheduleDelayedPost(flow.id, post.externalId, readyAt)
        continue
      }
      await this.forwardPost(flow, post)
    }

    const readyIds = flowStateStore.popReadyDelayedPosts(flow.id, Date.now())
    for (const postId of readyIds) {
      const post = posts.find((p) => p.externalId === postId)
      if (post && this.applyFilters(post, flow.filters)) {
        await this.forwardPost(flow, post)
      }
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

  private async fetchNewPosts(flow: FlowRecord): Promise<ExternalPost[]> {
    const integ = integrationsStore.getIntegration(flow.source.integrationId)
    if (!integ || integ.status !== 'connected') return []

    const cursor = flowStateStore.getLastMessageId(flow.id)

    if (flow.source.platform === 'telegram') {
      const tgToken = getTelegramToken() || integ.token
      if (!tgToken) return []
      const channelKey = flow.source.channelId ?? flow.source.channelUsername ?? ''
      const { posts, lastMessageId } = await fetchTelegramChannelPosts(
        tgToken,
        channelKey,
        cursor,
      )
      if (lastMessageId > cursor) {
        await flowStateStore.setLastMessageId(flow.id, lastMessageId)
      }
      return posts
    }

    if (flow.source.platform === 'vk') {
      const groupKey = flow.source.channelId ?? integ.groupId ?? ''
      const { posts, lastPostId } = await fetchVkWallPosts(integ.token, groupKey, cursor)
      if (lastPostId > cursor) {
        await flowStateStore.setLastMessageId(flow.id, lastPostId)
      }
      return posts
    }

    return []
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
