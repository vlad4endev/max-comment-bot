import axios from 'axios'

import { logger } from '../utils/logger'
import type { IntegrationPlatform } from './integrationsStore'

export interface PlatformTestResult {
  ok: boolean
  info?: string
  error?: string
}

export interface PlatformChannelInfo {
  id: string
  title: string
  username?: string
}

const TG_API = 'https://api.telegram.org'

export async function validateTelegramToken(token: string): Promise<PlatformTestResult> {
  try {
    const { data } = await axios.get<{ ok: boolean; result?: { username?: string; first_name?: string } }>(
      `${TG_API}/bot${token}/getMe`,
      { timeout: 15_000 },
    )
    if (!data.ok || !data.result) {
      return { ok: false, error: 'Telegram API вернул ошибку' }
    }
    const name = data.result.username ? `@${data.result.username}` : data.result.first_name ?? 'bot'
    return { ok: true, info: name }
  } catch (err: unknown) {
    logger.debug('validateTelegramToken failed', err)
    return { ok: false, error: 'Не удалось проверить токен Telegram' }
  }
}

export async function validateVkToken(
  token: string,
  groupId?: string,
): Promise<PlatformTestResult> {
  try {
    const params: Record<string, string | number> = {
      access_token: token,
      v: '5.199',
    }
    if (groupId && groupId.trim() !== '') {
      params.group_id = groupId.replace(/^-/, '').replace(/^public/, '')
    }
    const { data } = await axios.get<{
      response?: Array<{ name?: string; screen_name?: string }>
      error?: { error_msg?: string }
    }>('https://api.vk.com/method/groups.getById', { params, timeout: 15_000 })

    if (data.error) {
      return { ok: false, error: data.error.error_msg ?? 'VK API error' }
    }
    const g = data.response?.[0]
    if (!g && groupId) {
      const userCheck = await axios.get<{
        response?: Array<{ first_name?: string; last_name?: string }>
        error?: { error_msg?: string }
      }>('https://api.vk.com/method/users.get', {
        params: { access_token: token, v: '5.199' },
        timeout: 15_000,
      })
      if (userCheck.data.error) {
        return { ok: false, error: userCheck.data.error.error_msg ?? 'VK token invalid' }
      }
      const u = userCheck.data.response?.[0]
      return {
        ok: true,
        info: u ? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() : 'VK token OK',
      }
    }
    return {
      ok: true,
      info: g ? g.name ?? g.screen_name ?? 'VK сообщество' : 'VK token OK',
    }
  } catch (err: unknown) {
    logger.debug('validateVkToken failed', err)
    return { ok: false, error: 'Не удалось проверить токен VK' }
  }
}

export async function testIntegration(
  platform: IntegrationPlatform,
  token: string,
  groupId?: string,
): Promise<PlatformTestResult> {
  if (platform === 'telegram') return validateTelegramToken(token)
  return validateVkToken(token, groupId)
}

export async function listTelegramAdminChannels(token: string): Promise<PlatformChannelInfo[]> {
  try {
    const { data } = await axios.get<{
      ok: boolean
      result?: Array<{
        id: number
        title?: string
        username?: string
        type?: string
      }>
    }>(`${TG_API}/bot${token}/getUpdates`, {
      params: { limit: 100, allowed_updates: ['channel_post', 'my_chat_member'] },
      timeout: 15_000,
    })
    if (!data.ok || !data.result) return []
    const seen = new Map<string, PlatformChannelInfo>()
    for (const upd of data.result) {
      const post = (upd as Record<string, unknown>).channel_post as Record<string, unknown> | undefined
      const chat = post?.chat as Record<string, unknown> | undefined
      if (chat && typeof chat.id === 'number') {
        const id = String(chat.id)
        if (!seen.has(id)) {
          seen.set(id, {
            id,
            title: typeof chat.title === 'string' ? chat.title : id,
            username: typeof chat.username === 'string' ? `@${chat.username}` : undefined,
          })
        }
      }
    }
    return [...seen.values()]
  } catch (err: unknown) {
    logger.debug('listTelegramAdminChannels failed', err)
    return []
  }
}

export async function listVkGroups(token: string, groupId?: string): Promise<PlatformChannelInfo[]> {
  if (!groupId || groupId.trim() === '') {
    return []
  }
  try {
    const { data } = await axios.get<{
      response?: Array<{ id: number; name?: string; screen_name?: string }>
      error?: { error_msg?: string }
    }>('https://api.vk.com/method/groups.getById', {
      params: {
        access_token: token,
        group_id: groupId.replace(/^-/, '').replace(/^public/, ''),
        v: '5.199',
      },
      timeout: 15_000,
    })
    if (data.error || !data.response?.length) return []
    return data.response.map((g) => ({
      id: String(-g.id),
      title: g.name ?? String(g.id),
      username: g.screen_name ? g.screen_name : undefined,
    }))
  } catch (err: unknown) {
    logger.debug('listVkGroups failed', err)
    return []
  }
}

export interface ExternalPost {
  externalId: string
  text: string
  hasMedia: boolean
  createdAt?: number
}

export async function fetchTelegramChannelPosts(
  token: string,
  channelId: string,
  afterMessageId: number,
): Promise<{ posts: ExternalPost[]; lastMessageId: number }> {
  try {
    const { data } = await axios.get<{
      ok: boolean
      result?: Array<Record<string, unknown>>
    }>(`${TG_API}/bot${token}/getUpdates`, {
      params: { limit: 100, allowed_updates: ['channel_post'] },
      timeout: 15_000,
    })
    if (!data.ok || !data.result) return { posts: [], lastMessageId: afterMessageId }

    const posts: ExternalPost[] = []
    let maxId = afterMessageId
    const targetId = channelId.replace(/^@/, '')

    for (const upd of data.result) {
      const updateId = typeof upd.update_id === 'number' ? upd.update_id : 0
      if (updateId > maxId) maxId = updateId

      const msg = upd.channel_post as Record<string, unknown> | undefined
      if (!msg) continue
      const chat = msg.chat as Record<string, unknown> | undefined
      if (!chat) continue
      const chatKey =
        typeof chat.username === 'string'
          ? chat.username.toLowerCase()
          : String(chat.id)
      const match =
        targetId.startsWith('-') || /^\d+$/.test(targetId)
          ? String(chat.id) === targetId
          : chatKey === targetId.toLowerCase().replace(/^@/, '')
      if (!match) continue

      const messageId = typeof msg.message_id === 'number' ? msg.message_id : 0
      if (messageId <= afterMessageId) continue

      const text =
        typeof msg.text === 'string'
          ? msg.text
          : typeof msg.caption === 'string'
            ? msg.caption
            : ''
      const hasMedia = Array.isArray(msg.photo) || msg.video != null || msg.document != null
      posts.push({
        externalId: String(messageId),
        text,
        hasMedia,
        createdAt: typeof msg.date === 'number' ? msg.date * 1000 : undefined,
      })
    }

    return { posts, lastMessageId: maxId }
  } catch (err: unknown) {
    logger.warn('fetchTelegramChannelPosts failed', err)
    return { posts: [], lastMessageId: afterMessageId }
  }
}

export async function fetchVkWallPosts(
  token: string,
  groupId: string,
  afterPostId: number,
): Promise<{ posts: ExternalPost[]; lastPostId: number }> {
  const ownerId = groupId.startsWith('-') ? groupId : `-${groupId.replace(/^public/, '')}`
  try {
    const { data } = await axios.get<{
      response?: { items?: Array<Record<string, unknown>> }
      error?: { error_msg?: string }
    }>('https://api.vk.com/method/wall.get', {
      params: {
        access_token: token,
        owner_id: ownerId,
        count: 20,
        filter: 'owner',
        v: '5.199',
      },
      timeout: 15_000,
    })
    if (data.error || !data.response?.items) {
      return { posts: [], lastPostId: afterPostId }
    }

    const posts: ExternalPost[] = []
    let maxId = afterPostId
    for (const item of data.response.items) {
      const id = typeof item.id === 'number' ? item.id : 0
      if (id > maxId) maxId = id
      if (id <= afterPostId) continue
      const text = typeof item.text === 'string' ? item.text : ''
      const attachments = item.attachments
      const hasMedia = Array.isArray(attachments) && attachments.length > 0
      posts.push({
        externalId: String(id),
        text,
        hasMedia,
        createdAt: typeof item.date === 'number' ? item.date * 1000 : undefined,
      })
    }
    return { posts, lastPostId: maxId }
  } catch (err: unknown) {
    logger.warn('fetchVkWallPosts failed', err)
    return { posts: [], lastPostId: afterPostId }
  }
}

export async function publishVkWallPost(
  token: string,
  groupId: string,
  message: string,
): Promise<void> {
  const ownerId = groupId.startsWith('-') ? groupId : `-${groupId.replace(/^public/, '')}`
  const { data } = await axios.get<{ error?: { error_msg?: string } }>(
    'https://api.vk.com/method/wall.post',
    {
      params: {
        access_token: token,
        owner_id: ownerId,
        from_group: 1,
        message,
        v: '5.199',
      },
      timeout: 15_000,
    },
  )
  if (data.error) {
    throw new Error(data.error.error_msg ?? 'VK wall.post failed')
  }
}
