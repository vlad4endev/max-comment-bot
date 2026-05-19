/**
 * Одноразовый вход user-аккаунта Telegram → строка сессии для TG_USER_SESSION в .env
 *
 * 1. Получите api_id и api_hash на https://my.telegram.org/apps
 * 2. Запуск: TG_API_ID=... TG_API_HASH=... npm run tg:user-login
 */
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'

function ask(rl: readline.Interface, label: string): Promise<string> {
  return rl.question(label)
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input, output })
  try {
    const apiIdRaw =
      process.env.TG_API_ID?.trim() || (await ask(rl, 'TG_API_ID (my.telegram.org): '))
    const apiHash =
      process.env.TG_API_HASH?.trim() || (await ask(rl, 'TG_API_HASH: '))
    const apiId = Number.parseInt(apiIdRaw, 10)
    if (!Number.isFinite(apiId) || !apiHash) {
      console.error('Нужны корректные TG_API_ID и TG_API_HASH')
      process.exit(1)
    }

    const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
      connectionRetries: 3,
    })

    await client.start({
      phoneNumber: async () => await ask(rl, 'Номер телефона (+7…): '),
      phoneCode: async () => await ask(rl, 'Код из Telegram: '),
      password: async () => await ask(rl, 'Пароль 2FA (если есть, иначе Enter): '),
      onError: (err) => console.error(err),
    })

    const session = client.session.save() as unknown as string
    console.log('\nДобавьте в .env:\n')
    console.log(`TG_API_ID=${apiId}`)
    console.log(`TG_API_HASH=${apiHash}`)
    console.log(`TG_USER_SESSION=${session}`)
    console.log('\nНе публикуйте TG_USER_SESSION — это полный доступ к аккаунту.\n')
    await client.disconnect()
  } finally {
    rl.close()
  }
}

void main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
