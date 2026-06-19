/**
 * vkPostMappingStore.ts
 *
 * Хранит маппинг: MAX message mid → VK wall post_id (и обратно).
 * Используется vkChainForwarder для синхронизации комментариев.
 *
 * Персистируется в data/vk-post-mapping.json.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { logger } from '../utils/logger'

const DATA_PATH = join(process.cwd(), 'data', 'vk-post-mapping.json')

interface VkPostMappingEntry {
  /** chainId связки VK */
  chainId: string
  /** MAX channel chat ID */
  maxChatId: number
  /** MAX message mid */
  maxMid: string
  /** VK wall post_id */
  vkPostId: number
  /** VK group_id (без минуса) */
  vkGroupId: string
  /** ID последнего обработанного комментария VK для этого поста */
  lastVkCommentId: number
  createdAt: string
}

interface MappingFile {
  entries: VkPostMappingEntry[]
}

class VkPostMappingStore {
  private data: MappingFile = { entries: [] }
  private loaded = false

  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await readFile(DATA_PATH, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed === 'object' && parsed !== null) {
        const o = parsed as Record<string, unknown>
        this.data = {
          entries: Array.isArray(o.entries) ? (o.entries as VkPostMappingEntry[]) : [],
        }
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== 'ENOENT') {
        logger.warn('vkPostMappingStore: load failed, using empty', err)
      }
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(DATA_PATH), { recursive: true })
    await writeFile(DATA_PATH, JSON.stringify(this.data, null, 2), 'utf8')
  }

  async upsert(entry: Omit<VkPostMappingEntry, 'createdAt'>): Promise<void> {
    await this.load()
    const idx = this.data.entries.findIndex(
      (e) => e.chainId === entry.chainId && e.maxMid === entry.maxMid,
    )
    if (idx >= 0) {
      this.data.entries[idx] = { ...this.data.entries[idx], ...entry }
    } else {
      this.data.entries.push({ ...entry, createdAt: new Date().toISOString() })
    }
    await this.persist()
  }

  async updateLastCommentId(chainId: string, vkPostId: number, lastVkCommentId: number): Promise<void> {
    await this.load()
    const idx = this.data.entries.findIndex(
      (e) => e.chainId === chainId && e.vkPostId === vkPostId,
    )
    if (idx >= 0) {
      this.data.entries[idx].lastVkCommentId = lastVkCommentId
      await this.persist()
    }
  }

  findByMaxMid(chainId: string, maxMid: string): VkPostMappingEntry | undefined {
    return this.data.entries.find((e) => e.chainId === chainId && e.maxMid === maxMid)
  }

  findByVkPostId(chainId: string, vkPostId: number): VkPostMappingEntry | undefined {
    return this.data.entries.find((e) => e.chainId === chainId && e.vkPostId === vkPostId)
  }

  /** Все активные записи для цепочки (для поллинга комментариев). */
  listByChain(chainId: string): VkPostMappingEntry[] {
    return this.data.entries.filter((e) => e.chainId === chainId)
  }

  /** Удалить записи старше N дней (чтобы файл не рос бесконечно). */
  async pruneOlderThan(days: number): Promise<number> {
    await this.load()
    const cutoff = Date.now() - days * 86_400_000
    const before = this.data.entries.length
    this.data.entries = this.data.entries.filter((e) => {
      const ts = new Date(e.createdAt).getTime()
      return Number.isFinite(ts) && ts > cutoff
    })
    const pruned = before - this.data.entries.length
    if (pruned > 0) {
      await this.persist()
    }
    return pruned
  }
}

export const vkPostMappingStore = new VkPostMappingStore()
