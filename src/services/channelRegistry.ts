import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ChatType } from '@maxhub/max-bot-api/types'

import { logger } from '../utils/logger'

/**
 * Persisted metadata for a chat where the bot is (or was) present.
 */
export interface ChannelRecord {
  chat_id: number
  title: string | null
  type: ChatType
  /** ISO 8601 timestamp — set when the channel is first registered */
  date_added: string
}

/**
 * Fields supplied when registering or refreshing a channel (without {@link ChannelRecord.chat_id}).
 */
export interface ChannelSaveInput {
  title: string | null
  type: ChatType
}

interface ChannelsFileShape {
  channels: ChannelRecord[]
}

const DEFAULT_CHANNELS_PATH = join(process.cwd(), 'channels.json')

function isChatType(value: unknown): value is ChatType {
  return value === 'dialog' || value === 'chat' || value === 'channel'
}

function isChannelRecord(value: unknown): value is ChannelRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const o = value as Record<string, unknown>
  return (
    typeof o.chat_id === 'number' &&
    Number.isInteger(o.chat_id) &&
    (o.title === null || typeof o.title === 'string') &&
    isChatType(o.type) &&
    typeof o.date_added === 'string'
  )
}

/**
 * JSON-backed registry of chats the bot participates in.
 * Keeps an in-memory map synchronized with {@link DEFAULT_CHANNELS_PATH}.
 */
export class ChannelRegistry {
  private readonly channels = new Map<number, ChannelRecord>()
  private readonly filePath: string
  private persistChain: Promise<void> = Promise.resolve()

  constructor(filePath: string = DEFAULT_CHANNELS_PATH) {
    this.filePath = filePath
  }

  /**
   * Читает `channels.json` и заполняет память. Повторные вызовы перезаписывают кэш.
   */
  async loadFromDisk(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw) as unknown
      if (typeof parsed !== 'object' || parsed === null || !('channels' in parsed)) {
        logger.warn('channelRegistry: неверный формат channels.json, очищаю память')
        this.channels.clear()
        return
      }
      const list = (parsed as ChannelsFileShape).channels
      if (!Array.isArray(list)) {
        this.channels.clear()
        return
      }
      this.channels.clear()
      for (const item of list) {
        if (isChannelRecord(item)) {
          this.channels.set(item.chat_id, item)
        }
      }
      logger.info(`channelRegistry: загружено ${this.channels.size} канал(ов)`)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        logger.debug('channelRegistry: файл channels.json отсутствует, начинаем с пустого реестра')
        return
      }
      logger.error('channelRegistry: не удалось прочитать channels.json', e)
    }
  }

  /**
   * Сохраняет или обновляет канал. Для уже известного `chat_id` поле {@link ChannelRecord.date_added} не меняется.
   */
  saveChannel(chatId: number, chatData: ChannelSaveInput): void {
    const existing = this.channels.get(chatId)
    const record: ChannelRecord = existing
      ? {
          ...existing,
          title: chatData.title ?? existing.title,
          type: chatData.type,
        }
      : {
          chat_id: chatId,
          title: chatData.title,
          type: chatData.type,
          date_added: new Date().toISOString(),
        }
    this.channels.set(chatId, record)
    this.queuePersist()
  }

  /**
   * Удаляет канал из реестра. Возвращает удалённую запись (для текста уведомления) или `null`, если чата не было.
   */
  removeChannel(chatId: number): ChannelRecord | null {
    const prev = this.channels.get(chatId) ?? null
    if (prev === null) {
      return null
    }
    this.channels.delete(chatId)
    this.queuePersist()
    return prev
  }

  /**
   * Возвращает запись по `chat_id` или `null`.
   */
  getChannel(chatId: number): ChannelRecord | null {
    return this.channels.get(chatId) ?? null
  }

  /**
   * Все каналы из текущего реестра, отсортированные по `chat_id`.
   */
  getAllChannels(): ChannelRecord[] {
    return [...this.channels.values()].sort((a, b) => a.chat_id - b.chat_id)
  }

  private queuePersist(): void {
    this.persistChain = this.persistChain
      .then(() => this.persist())
      .catch((e: unknown) => {
        logger.error('channelRegistry: ошибка записи channels.json', e)
      })
  }

  private async persist(): Promise<void> {
    const dir = dirname(this.filePath)
    await mkdir(dir, { recursive: true })
    const body: ChannelsFileShape = {
      channels: this.getAllChannels(),
    }
    await writeFile(this.filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  }
}

export const channelRegistry = new ChannelRegistry()
