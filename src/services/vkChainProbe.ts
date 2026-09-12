import { listTgChains, type TgChainRecord } from '../api/adminPanelState'
import {
  deleteVkWallPost,
  detectVkTokenKind,
  inspectVkGroupAccess,
  probeVkWallReadable,
  publishVkWallPost,
  type VkGroupInfo,
  type VkTokenKind,
} from './integrationPlatformClient'

export type VkChainCheckItem = {
  id: string
  ok: boolean
  label: string
  detail?: string
}

export type VkChainCheckResult = {
  ok: boolean
  checks: VkChainCheckItem[]
  group: VkGroupInfo | null
  token_kind: VkTokenKind
  tg_chain: {
    id: string
    max_chat_id: number
    max_title: string | null
    tg_username: string
    tg_channel_id?: string
    active: boolean
  } | null
  test_post?: {
    posted: boolean
    deleted: boolean
    post_id?: number
    url?: string
  }
}

function findTgChainForMaxChat(chains: TgChainRecord[], maxChatId: number): TgChainRecord | null {
  const abs = Math.abs(maxChatId)
  const matches = chains.filter((c) => Math.abs(c.max_chat_id) === abs)
  return matches.find((c) => c.active) ?? matches[0] ?? null
}

function tgChainLabel(chain: TgChainRecord): string {
  const name = chain.tg_username
    ? `@${chain.tg_username.replace(/^@/, '')}`
    : chain.tg_channel_id || 'Telegram'
  const max = chain.max_title?.trim() || String(chain.max_chat_id)
  return `${name} → MAX «${max}»`
}

export async function probeVkChainSetup(input: {
  maxChatId: number
  vkGroupId: string
  vkToken: string
  publishTest?: boolean
}): Promise<VkChainCheckResult> {
  const checks: VkChainCheckItem[] = []
  const tgChains = await listTgChains()
  const tg = findTgChainForMaxChat(tgChains, input.maxChatId)

  checks.push({
    id: 'tg_source',
    ok: Boolean(tg),
    label: 'Канал Telegram',
    detail: tg
      ? tgChainLabel(tg)
      : 'Нет связки Telegram → MAX на этот канал. Сначала создайте её во вкладке Telegram → MAX.',
  })
  checks.push({
    id: 'tg_active',
    ok: Boolean(tg?.active && tg.forward_posts !== false),
    label: 'Пересылка Telegram → MAX',
    detail: !tg
      ? 'Нечего проверять без TG→MAX'
      : tg.active && tg.forward_posts !== false
        ? 'Активна — посты из Telegram дойдут до VK'
        : 'Связка TG→MAX на паузе или пересылка постов выключена',
  })

  const tokenProbe = await detectVkTokenKind(input.vkToken)
  checks.push({
    id: 'vk_token',
    ok: !tokenProbe.error,
    label: 'Токен VK',
    detail: tokenProbe.error
      ? tokenProbe.error
      : tokenProbe.kind === 'group'
        ? 'Токен сообщества: текст публикуется, фото и видео на стену VK может не загрузить'
        : tokenProbe.kind === 'user'
          ? 'Пользовательский токен — подходит для публикации на стену'
          : 'Токен принят',
  })

  const access = await inspectVkGroupAccess(input.vkToken, input.vkGroupId)
  const group = access.info?.group ?? null
  checks.push({
    id: 'vk_group',
    ok: Boolean(access.info),
    label: 'Сообщество VK',
    detail: access.info
      ? `${access.info.group.name} (vk.com/${access.info.group.screenName})`
      : access.error || 'Сообщество не найдено',
  })
  checks.push({
    id: 'vk_can_post',
    ok: Boolean(access.info?.canPost || tokenProbe.kind === 'group'),
    label: 'Право публикации на стену',
    detail: !access.info
      ? 'Нет данных о правах'
      : access.info.canPost || access.info.isAdmin
        ? access.info.adminLevel != null
          ? `Есть права (уровень ${access.info.adminLevel})`
          : 'Есть права администратора или редактора'
        : tokenProbe.kind === 'group'
          ? 'Токен сообщества: публикация от имени группы должна работать'
          : 'Нет права wall.post. Нужен админ или редактор сообщества',
  })

  const wall = group
    ? await probeVkWallReadable(input.vkToken, group.id)
    : { ok: false, error: 'Сначала найдите сообщество' }
  checks.push({
    id: 'vk_wall',
    ok: wall.ok,
    label: 'Доступ к стене',
    detail: wall.ok ? 'Стена читается — публикация возможна' : wall.error || 'Нет доступа к стене',
  })

  let testPost: VkChainCheckResult['test_post']
  if (input.publishTest && group && !tokenProbe.error) {
    const stamp = new Date().toLocaleString('ru-RU')
    const message = `Проверка связки Telegram → VK (${stamp}). Этот пост можно удалить.`
    try {
      const postId = await publishVkWallPost(input.vkToken, group.id, message)
      if (postId) {
        const deleted = await deleteVkWallPost(input.vkToken, group.id, postId)
        testPost = {
          posted: true,
          deleted,
          post_id: postId,
          url: `https://vk.com/wall-${group.id}_${postId}`,
        }
        checks.push({
          id: 'test_post',
          ok: true,
          label: 'Тестовый пост',
          detail: deleted
            ? `Опубликован и сразу удалён (id ${postId})`
            : `Опубликован, но не удалось удалить: vk.com/wall-${group.id}_${postId}`,
        })
      } else {
        testPost = { posted: false, deleted: false }
        checks.push({
          id: 'test_post',
          ok: false,
          label: 'Тестовый пост',
          detail: 'VK не вернул id поста — публикация не удалась',
        })
      }
    } catch (err: unknown) {
      const messageText = err instanceof Error ? err.message : String(err)
      testPost = { posted: false, deleted: false }
      checks.push({
        id: 'test_post',
        ok: false,
        label: 'Тестовый пост',
        detail: messageText,
      })
    }
  }

  const required = checks.filter((c) => c.id !== 'test_post')
  const ok = required.every((c) => c.ok)

  return {
    ok,
    checks,
    group,
    token_kind: tokenProbe.kind,
    tg_chain: tg
      ? {
          id: tg.id,
          max_chat_id: tg.max_chat_id,
          max_title: tg.max_title,
          tg_username: tg.tg_username,
          tg_channel_id: tg.tg_channel_id,
          active: tg.active,
        }
      : null,
    test_post: testPost,
  }
}
