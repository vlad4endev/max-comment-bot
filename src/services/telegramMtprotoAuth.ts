import { randomUUID } from 'node:crypto'

import { Api, TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'

import { logger } from '../utils/logger'
import { getGramJsClientOptions } from '../utils/telegramProxyRuntime'
import {
  clearMtprotoSession,
  maskPhone,
  readMtprotoConfigFile,
  resolveMtprotoCredentials,
  writeMtprotoConfigFile,
  type MtprotoConfigFile,
} from './mtprotoConfigStore'

const PENDING_TTL_MS = 15 * 60 * 1000

interface PendingLogin {
  id: string
  client: TelegramClient
  phone: string
  phoneCodeHash: string
  isCodeViaApp: boolean
  apiId: number
  apiHash: string
  createdAt: number
  needsPassword: boolean
}

const pendingLogins = new Map<string, PendingLogin>()

function cleanupPending(): void {
  const now = Date.now()
  for (const [id, p] of pendingLogins) {
    if (now - p.createdAt > PENDING_TTL_MS) {
      void p.client.disconnect().catch(() => {})
      pendingLogins.delete(id)
    }
  }
}

function requireApiCredentials(): { apiId: number; apiHash: string } {
  const { apiId, apiHash } = resolveMtprotoCredentials()
  if (apiId === null || !apiHash) {
    throw new Error('Укажите api_id и api_hash (my.telegram.org → API development tools)')
  }
  return { apiId, apiHash }
}

function userLabel(user: Api.TypeUser): string {
  if (user instanceof Api.User) {
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
    if (user.username) {
      return name ? `${name} (@${user.username})` : `@${user.username}`
    }
    return name || `id ${user.id}`
  }
  return 'Telegram user'
}

async function disconnectQuiet(client: TelegramClient): Promise<void> {
  try {
    await client.disconnect()
  } catch {
    /* ignore */
  }
}

export interface MtprotoStatusView {
  configured: boolean
  has_credentials: boolean
  has_session: boolean
  session_valid: boolean | null
  source: string
  api_id: number | null
  api_hash_set: boolean
  phone_masked: string | null
  user_display: string | null
  updated_at: string | null
  hint: string | null
}

export async function getMtprotoStatus(): Promise<MtprotoStatusView> {
  const resolved = resolveMtprotoCredentials()
  const file = readMtprotoConfigFile()
  const hasCredentials = resolved.apiId !== null && resolved.apiHash !== ''
  const hasSession = resolved.session !== ''
  let sessionValid: boolean | null = null
  let hint: string | null = null

  if (!hasCredentials) {
    hint = 'Получите api_id и api_hash на my.telegram.org и сохраните ниже.'
  } else if (!hasSession) {
    hint = 'Войдите по номеру телефона — код придёт в Telegram.'
  } else {
    hint = 'Нажмите «Проверить подключение» перед импортом архива.'
  }

  return {
    configured: resolved.apiId !== null && resolved.apiHash !== '' && resolved.session !== '',
    has_credentials: hasCredentials,
    has_session: hasSession,
    session_valid: sessionValid,
    source: resolved.source,
    api_id: resolved.apiId,
    api_hash_set: resolved.apiHash !== '',
    phone_masked: file?.phone ? maskPhone(file.phone) : null,
    user_display: file?.userDisplay ?? null,
    updated_at: file?.updatedAt ?? null,
    hint,
  }
}

export function saveMtprotoCredentials(apiId: number, apiHash: string): MtprotoConfigFile {
  if (!Number.isFinite(apiId) || apiId <= 0) {
    throw new Error('api_id должен быть положительным числом')
  }
  const hash = apiHash.trim()
  if (!hash) {
    throw new Error('api_hash обязателен')
  }
  return writeMtprotoConfigFile({ apiId, apiHash: hash })
}

export async function sendMtprotoLoginCode(phoneRaw: string): Promise<{
  login_id: string
  is_code_via_app: boolean
  phone_masked: string
}> {
  cleanupPending()
  const phone = phoneRaw.trim().replace(/\s/g, '')
  if (!phone) {
    throw new Error('Укажите номер телефона')
  }
  const { apiId, apiHash } = requireApiCredentials()

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, getGramJsClientOptions())
  await client.connect()

  try {
    const { phoneCodeHash, isCodeViaApp } = await client.sendCode({ apiId, apiHash }, phone)
    const id = randomUUID()
    pendingLogins.set(id, {
      id,
      client,
      phone,
      phoneCodeHash,
      isCodeViaApp: !!isCodeViaApp,
      apiId,
      apiHash,
      createdAt: Date.now(),
      needsPassword: false,
    })
    return {
      login_id: id,
      is_code_via_app: !!isCodeViaApp,
      phone_masked: maskPhone(phone),
    }
  } catch (err) {
    await disconnectQuiet(client)
    throw err
  }
}

async function persistSessionFromClient(
  client: TelegramClient,
  phone: string,
  user: Api.TypeUser,
): Promise<void> {
  const session = client.session.save() as unknown as string
  if (!session) {
    throw new Error('Не удалось сохранить сессию')
  }
  const { apiId, apiHash } = requireApiCredentials()
  writeMtprotoConfigFile({
    apiId,
    apiHash,
    session,
    phone,
    userId: user instanceof Api.User ? String(user.id) : undefined,
    userDisplay: userLabel(user),
  })
}

export async function confirmMtprotoLoginCode(
  loginId: string,
  codeRaw: string,
): Promise<{ ok: true; user_display: string } | { ok: false; needs_password: true; login_id: string }> {
  cleanupPending()
  const pending = pendingLogins.get(loginId)
  if (!pending) {
    throw new Error('Сессия входа истекла — запросите код заново')
  }
  const code = codeRaw.trim().replace(/\s/g, '')
  if (!code) {
    throw new Error('Введите код из Telegram')
  }

  try {
    const result = await pending.client.invoke(
      new Api.auth.SignIn({
        phoneNumber: pending.phone,
        phoneCodeHash: pending.phoneCodeHash,
        phoneCode: code,
      }),
    )
    const user =
      result instanceof Api.auth.Authorization ? result.user : null
    if (!user) {
      throw new Error('Неожиданный ответ Telegram при входе')
    }
    await persistSessionFromClient(pending.client, pending.phone, user)
    pendingLogins.delete(loginId)
    await disconnectQuiet(pending.client)
    return { ok: true, user_display: userLabel(user) }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const rpc =
      typeof err === 'object' && err !== null && 'errorMessage' in err
        ? String((err as { errorMessage?: string }).errorMessage)
        : ''
    if (rpc === 'SESSION_PASSWORD_NEEDED' || msg.includes('SESSION_PASSWORD_NEEDED')) {
      pending.needsPassword = true
      return { ok: false, needs_password: true, login_id: loginId }
    }
    throw err
  }
}

export async function confirmMtprotoPassword(
  loginId: string,
  passwordRaw: string,
): Promise<{ ok: true; user_display: string }> {
  cleanupPending()
  const pending = pendingLogins.get(loginId)
  if (!pending) {
    throw new Error('Сессия входа истекла — начните с отправки кода')
  }
  const password = passwordRaw
  if (!password) {
    throw new Error('Введите пароль двухфакторной аутентификации')
  }

  try {
    const user = await pending.client.signInWithPassword(
      { apiId: pending.apiId, apiHash: pending.apiHash },
      {
        password: async () => password,
        onError: async (e) => {
          throw e
        },
      },
    )
    await persistSessionFromClient(pending.client, pending.phone, user)
    pendingLogins.delete(loginId)
    await disconnectQuiet(pending.client)
    return { ok: true, user_display: userLabel(user) }
  } catch (err) {
    throw err
  }
}

export async function testMtprotoConnection(): Promise<{ user_display: string }> {
  const { apiId, apiHash, session } = resolveMtprotoCredentials()
  if (apiId === null || !apiHash || !session) {
    throw new Error('MTProto не настроен: нужны api_id, api_hash и сессия')
  }
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, getGramJsClientOptions())
  await client.connect()
  try {
    if (!(await client.checkAuthorization())) {
      throw new Error('Сессия недействительна — войдите заново')
    }
    const me = await client.getMe()
    return { user_display: userLabel(me) }
  } finally {
    await disconnectQuiet(client)
  }
}

export function logoutMtprotoSession(): void {
  clearMtprotoSession()
  for (const [, p] of pendingLogins) {
    void disconnectQuiet(p.client)
  }
  pendingLogins.clear()
  logger.info('[mtproto] session cleared from admin')
}
