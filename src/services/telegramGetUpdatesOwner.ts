/**
 * Telegram разрешает только один getUpdates на токен.
 * Живой long-poll форвардера помечает токен здесь, чтобы miniapp/discovery
 * не перехватывали очередь и не сдвигали offset без пересылки channel_post.
 */

const ownedTokens = new Set<string>()

export function setTelegramGetUpdatesOwner(token: string, active: boolean): void {
  const trimmed = token.trim()
  if (!trimmed) {
    return
  }
  if (active) {
    ownedTokens.add(trimmed)
  } else {
    ownedTokens.delete(trimmed)
  }
}

export function isTelegramGetUpdatesOwnedByForwarder(token: string): boolean {
  return ownedTokens.has(token.trim())
}
