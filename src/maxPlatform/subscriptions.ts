const PLATFORM_API = 'https://platform-api.max.ru'
const SUBSCRIPTION_TIMEOUT_MS = 20_000

/**
 * Типы апдейтов для webhook и long polling: базовые + события участия бота в чатах.
 */
export const BOT_WEBHOOK_UPDATE_TYPES = [
  'bot_started',
  'message_created',
  'message_callback',
  'bot_added',
  'bot_removed',
  'user_added',
  'user_removed',
] as const

const DEFAULT_UPDATE_TYPES = BOT_WEBHOOK_UPDATE_TYPES

export interface SetWebhookOptions {
  token: string
  url: string
  secret?: string
  updateTypes?: readonly string[]
}

export async function setWebhookSubscription(options: SetWebhookOptions): Promise<void> {
  const body: Record<string, unknown> = {
    url: options.url,
    update_types: options.updateTypes ?? [...DEFAULT_UPDATE_TYPES],
  }
  if (options.secret) {
    body.secret = options.secret
  }

  const res = await fetch(`${PLATFORM_API}/subscriptions`, {
    method: 'POST',
    headers: {
      Authorization: options.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SUBSCRIPTION_TIMEOUT_MS),
  })

  const raw = await res.text()
  if (!res.ok) {
    throw new Error(`POST /subscriptions: HTTP ${res.status} — ${raw}`)
  }

  let data: { success?: boolean; message?: string }
  try {
    data = JSON.parse(raw) as { success?: boolean; message?: string }
  } catch {
    throw new Error(`POST /subscriptions: невалидный JSON в ответе — ${raw}`)
  }

  if (data.success === false) {
    throw new Error(data.message ?? 'POST /subscriptions: success=false')
  }
}

export async function deleteWebhookSubscription(
  token: string,
  webhookUrl: string,
): Promise<void> {
  const u = new URL(`${PLATFORM_API}/subscriptions`)
  u.searchParams.set('url', webhookUrl)

  const res = await fetch(u.href, {
    method: 'DELETE',
    headers: { Authorization: token },
    signal: AbortSignal.timeout(SUBSCRIPTION_TIMEOUT_MS),
  })

  const raw = await res.text()
  if (!res.ok) {
    throw new Error(`DELETE /subscriptions: HTTP ${res.status} — ${raw}`)
  }

  if (raw.trim() === '') {
    return
  }

  let data: { success?: boolean; message?: string }
  try {
    data = JSON.parse(raw) as { success?: boolean; message?: string }
  } catch {
    throw new Error(`DELETE /subscriptions: невалидный JSON в ответе — ${raw}`)
  }

  if (data.success === false) {
    throw new Error(data.message ?? 'DELETE /subscriptions: success=false')
  }
}
