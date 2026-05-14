import { initializeBot, setupGracefulShutdown, startBot } from './bot'

async function main(): Promise<void> {
  const bot = initializeBot()
  setupGracefulShutdown(bot)
  await startBot(bot)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
