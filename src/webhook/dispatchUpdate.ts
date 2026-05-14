import type { Bot } from '@maxhub/max-bot-api'
import type { Update } from '@maxhub/max-bot-api/types'

export async function dispatchBotUpdate(bot: Bot, update: Update): Promise<void> {
  const handle = (bot as unknown as { handleUpdate: (u: Update) => Promise<void> })
    .handleUpdate
  await handle.call(bot, update)
}
