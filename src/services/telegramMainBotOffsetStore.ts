import { createHash } from 'node:crypto'

import { getDb } from '../db/database'

function tokenKey(token: string): string {
  return createHash('sha256').update(token.trim()).digest('hex').slice(0, 16)
}

/** Единый offset getUpdates для основного TG-бота (связки + mini app + discovery). */
export function getTelegramBotUpdatesOffset(token: string): number {
  const row = getDb()
    .prepare('SELECT scan_next_offset FROM tg_chain_reader_offsets WHERE token_key = ?')
    .get(tokenKey(token)) as { scan_next_offset: number } | undefined
  return row?.scan_next_offset ?? 0
}

export function setTelegramBotUpdatesOffset(token: string, offset: number): void {
  getDb()
    .prepare(
      `INSERT INTO tg_chain_reader_offsets (token_key, scan_next_offset) VALUES (?, ?)
       ON CONFLICT(token_key) DO UPDATE SET scan_next_offset = excluded.scan_next_offset`,
    )
    .run(tokenKey(token), offset)
}
