import type { Bot } from '@maxhub/max-bot-api'

import { channelRegistry } from './channelRegistry'
import {
  fullyDisconnectRegisteredChannel,
  maybePruneRegisteredChannelsNotAccessibleByBot,
  resolveRegisteredChannelAccess,
  type RegisteredChannelAccess,
} from './channelFullDisconnect'

export interface MaxLinkedChannelInfo {
  id: string
  title: string
  type: 'channel' | 'chat' | 'dialog'
  botIsAdmin: boolean
  access: RegisteredChannelAccess
  dateAdded: string
  admins?: Array<{
    user_id: number
    name: string
    is_owner: boolean
  }>
}

function accessLabel(access: RegisteredChannelAccess): string {
  if (access === 'ok') return 'админ'
  if (access === 'bot_not_admin') return 'не админ'
  if (access === 'bot_not_in_chat') return 'бот не в канале'
  return 'недоступен'
}

/**
 * Каналы MAX из реестра с проверкой через API (getChat, members/me).
 * При `syncRegistry` сначала убирает из реестра чаты, куда бот больше не добавлен.
 */
export async function listMaxBotLinkedChannels(
  bot: Bot,
  options?: { syncRegistry?: boolean; liveCheck?: boolean },
): Promise<MaxLinkedChannelInfo[]> {
  if (options?.syncRegistry) {
    await maybePruneRegisteredChannelsNotAccessibleByBot(bot)
  }

  const snapshot = channelRegistry.getAllChannels().filter((c) => c.type === 'channel')
  const out: MaxLinkedChannelInfo[] = []

  for (const c of snapshot) {
    if (channelRegistry.getChannel(c.chat_id) === null) {
      continue
    }

    let title = c.title ?? String(c.chat_id)
    let type = c.type

    if (options?.liveCheck !== false) {
      try {
        const chat = await bot.api.getChat(c.chat_id)
        if (chat.title) {
          title = chat.title
        }
        type = chat.type
        channelRegistry.saveChannel(c.chat_id, { title: chat.title ?? c.title, type: chat.type })
      } catch {
        /* оставляем данные реестра */
      }
    }

    const access = options?.liveCheck === false
      ? ('ok' as RegisteredChannelAccess)
      : await resolveRegisteredChannelAccess(bot, c.chat_id)

    let admins: MaxLinkedChannelInfo['admins'] = []
    try {
      const { members } = await bot.api.getChatAdmins(c.chat_id)
      admins = members
        .filter((m) => !m.is_bot && (m.is_admin || m.is_owner))
        .map((m) => ({
          user_id: m.user_id,
          name: m.name,
          is_owner: m.is_owner === true,
        }))
        .sort((a, b) => {
          const ownerDiff = Number(b.is_owner) - Number(a.is_owner)
          if (ownerDiff !== 0) return ownerDiff
          return a.name.localeCompare(b.name, 'ru')
        })
    } catch {
      admins = []
    }

    out.push({
      id: String(c.chat_id),
      title,
      type: type === 'channel' || type === 'chat' || type === 'dialog' ? type : 'channel',
      botIsAdmin: access === 'ok',
      access,
      dateAdded: c.date_added,
      admins,
    })
  }

  return out.sort((a, b) => {
    const adminDiff = Number(b.botIsAdmin) - Number(a.botIsAdmin)
    if (adminDiff !== 0) return adminDiff
    return a.title.localeCompare(b.title, 'ru')
  })
}

export function maxChannelAccessHint(channels: MaxLinkedChannelInfo[]): string | null {
  if (channels.length === 0) {
    return 'Добавьте бота в MAX-канал как администратора — канал появится после события подключения, затем нажмите «Загрузить».'
  }
  const adminCount = channels.filter((c) => c.botIsAdmin).length
  if (adminCount === 0) {
    return 'Каналы в реестре есть, но бот нигде не администратор. Выдайте права админа и нажмите «Загрузить».'
  }
  return null
}

export { accessLabel as maxChannelAccessLabel }
