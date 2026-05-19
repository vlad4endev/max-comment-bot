import { createHash } from 'node:crypto'

import { getTelegramToken } from '../config'
import { getDb } from '../db/database'
import { getTgFileUrl, getTelegramUpdatesWithIds, type TgMessage } from '../forwarder/telegramReader'
import {
  sendDocumentToMax,
  sendPhotoToMax,
  sendTextToMax,
  sendVideoToMax,
} from '../forwarder/maxPublisher'
import { listTgChains, updateTgChain, type TgChainRecord } from '../api/adminPanelState'
import { telegramChannelMatchesTarget } from '../utils/tgChannelMatch'
import { logger } from '../utils/logger'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

function getReaderOffset(tgToken: string): number {
  const row = getDb()
    .prepare('SELECT scan_next_offset FROM tg_chain_reader_offsets WHERE token_key = ?')
    .get(tokenKey(tgToken)) as { scan_next_offset: number } | undefined
  return row?.scan_next_offset ?? 0
}

function setReaderOffset(tgToken: string, offset: number): void {
  getDb()
    .prepare(
      `INSERT INTO tg_chain_reader_offsets (token_key, scan_next_offset) VALUES (?, ?)
       ON CONFLICT(token_key) DO UPDATE SET scan_next_offset = excluded.scan_next_offset`,
    )
    .run(tokenKey(tgToken), offset)
}

function chainSourceKey(chain: TgChainRecord): string {
  if (chain.tg_channel_id && chain.tg_channel_id.trim() !== '') {
    return chain.tg_channel_id.trim()
  }
  const u = chain.tg_username.trim().replace(/^@/, '')
  return u ? `@${u}` : ''
}

function isAlreadyForwarded(chainId: string, messageId: number): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM tg_chain_forwarded WHERE chain_id = ? AND tg_message_id = ?')
    .get(chainId, messageId)
  return !!row
}

function markForwarded(chainId: string, messageId: number): void {
  getDb()
    .prepare(
      'INSERT OR IGNORE INTO tg_chain_forwarded (chain_id, tg_message_id) VALUES (?, ?)',
    )
    .run(chainId, messageId)
}

function resolveTgToken(chain: TgChainRecord): string {
  const fromChain = chain.bot_token?.trim()
  if (fromChain) return fromChain
  return (process.env.TG_READER_BOT_TOKEN || '').trim() || getTelegramToken()
}

async function forwardMessageToMax(
  msg: TgMessage,
  tgToken: string,
  maxToken: string,
  maxChatId: number,
  addSignature: boolean,
): Promise<void> {
  const maxChannelId = String(maxChatId)
  let text = (msg.text || msg.caption || '').trim()
  if (addSignature && text) {
    text = `${text}\n\n— TG`
  }

  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1]
    const url = await getTgFileUrl(tgToken, largest.file_id)
    if (url) {
      await sendPhotoToMax(maxToken, maxChannelId, url, text)
      return
    }
  }
  if (msg.video?.file_id) {
    const url = await getTgFileUrl(tgToken, msg.video.file_id)
    if (url) {
      await sendVideoToMax(maxToken, maxChannelId, url, text)
      return
    }
  }
  if (msg.document?.file_id) {
    const url = await getTgFileUrl(tgToken, msg.document.file_id)
    if (url) {
      await sendDocumentToMax(maxToken, maxChannelId, url, text, {
        filename: msg.document.file_name,
        contentType: msg.document.mime_type,
      })
      return
    }
  }
  if (text) {
    await sendTextToMax(maxToken, maxChannelId, text)
  }
}

export async function runTgChainsOnce(): Promise<void> {
  const maxToken = (process.env.BOT_TOKEN || '').trim()
  if (!maxToken) {
    return
  }

  const chains = (await listTgChains()).filter(
    (c) => c.active && c.forward_posts && chainSourceKey(c) !== '',
  )
  if (chains.length === 0) {
    return
  }

  const tokenByChain = new Map<string, string>()
  for (const chain of chains) {
    const t = resolveTgToken(chain)
    if (!t) {
      logger.warn('[tgChain] no TG token for chain', { chainId: chain.id })
      continue
    }
    tokenByChain.set(chain.id, t)
  }

  const tokenGroups = new Map<string, TgChainRecord[]>()
  for (const chain of chains) {
    const token = tokenByChain.get(chain.id)
    if (!token) continue
    const list = tokenGroups.get(token) ?? []
    list.push(chain)
    tokenGroups.set(token, list)
  }

  for (const [tgToken, group] of tokenGroups) {
    const offset = getReaderOffset(tgToken)
    const batch = await getTelegramUpdatesWithIds(tgToken, offset, 0)
    let nextOffset = offset

    for (const u of batch) {
      nextOffset = Math.max(nextOffset, u.update_id + 1)
      const msg = u.channel_post
      if (!msg) continue

      for (const chain of group) {
        const sourceKey = chainSourceKey(chain)
        if (!telegramChannelMatchesTarget(msg.chat, sourceKey)) {
          continue
        }
        if (isAlreadyForwarded(chain.id, msg.message_id)) {
          continue
        }
        try {
          await forwardMessageToMax(
            msg,
            tgToken,
            maxToken,
            chain.max_chat_id,
            chain.add_signature,
          )
          markForwarded(chain.id, msg.message_id)
          const forwardedToday = chain.forwarded_today + 1
          chain.forwarded_today = forwardedToday
          await updateTgChain(chain.id, { forwarded_today: forwardedToday })
          logger.info('[tgChain] forwarded', {
            chainId: chain.id,
            from: sourceKey,
            to: chain.max_chat_id,
            messageId: msg.message_id,
          })
          await sleep(2000 + Math.random() * 3000)
        } catch (err: unknown) {
          logger.error('[tgChain] forward failed', {
            chainId: chain.id,
            from: sourceKey,
            to: chain.max_chat_id,
            err,
          })
          const errorsToday = chain.errors_today + 1
          chain.errors_today = errorsToday
          await updateTgChain(chain.id, { errors_today: errorsToday })
        }
      }
    }

    if (nextOffset > offset) {
      setReaderOffset(tgToken, nextOffset)
    }
  }
}

let loopStarted = false

export function startTgChainForwarder(): void {
  if (loopStarted) return
  loopStarted = true
  logger.info('[tgChain] forwarder started')
  const loop = async () => {
    while (true) {
      try {
        await runTgChainsOnce()
      } catch (err: unknown) {
        logger.error('[tgChain] loop error', err)
      }
      await sleep(30_000)
    }
  }
  void loop()
}
