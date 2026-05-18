import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { logger } from '../utils/logger'

const STATE_PATH = join(process.cwd(), 'data', 'flow-state.json')

interface FlowCursor {
  lastMessageId: number
  updatedAt?: string
  pendingPosts: Array<{ postId: string; readyAt: number }>
}

interface FlowStateFile {
  flows: Record<string, FlowCursor>
}

function defaultState(): FlowStateFile {
  return { flows: {} }
}

class FlowStateStore {
  private data: FlowStateFile = defaultState()
  private loaded = false

  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await readFile(STATE_PATH, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed === 'object' && parsed !== null) {
        const o = parsed as Record<string, unknown>
        if (typeof o.flows === 'object' && o.flows !== null) {
          this.data = { flows: o.flows as Record<string, FlowCursor> }
        }
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== 'ENOENT') {
        logger.warn('flowStateStore: load failed', err)
      }
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(STATE_PATH), { recursive: true })
    await writeFile(STATE_PATH, JSON.stringify(this.data, null, 2), 'utf8')
  }

  getLastMessageId(flowId: string): number {
    return this.data.flows[flowId]?.lastMessageId ?? 0
  }

  getCursorMeta(flowId: string): { lastMessageId: number; updatedAt: string | null } {
    const cur = this.data.flows[flowId]
    return {
      lastMessageId: cur?.lastMessageId ?? 0,
      updatedAt: cur?.updatedAt ?? null,
    }
  }

  async setLastMessageId(flowId: string, lastMessageId: number): Promise<void> {
    const cur = this.data.flows[flowId] ?? { lastMessageId: 0, pendingPosts: [] }
    cur.lastMessageId = lastMessageId
    cur.updatedAt = new Date().toISOString()
    this.data.flows[flowId] = cur
    await this.persist()
  }

  scheduleDelayedPost(flowId: string, postId: string, readyAt: number): Promise<void> {
    const cur = this.data.flows[flowId] ?? { lastMessageId: 0, pendingPosts: [] }
    if (!cur.pendingPosts.some((p) => p.postId === postId)) {
      cur.pendingPosts.push({ postId, readyAt })
    }
    this.data.flows[flowId] = cur
    return this.persist()
  }

  popReadyDelayedPosts(flowId: string, now: number): string[] {
    const cur = this.data.flows[flowId]
    if (!cur?.pendingPosts.length) return []
    const ready: string[] = []
    const pending: typeof cur.pendingPosts = []
    for (const p of cur.pendingPosts) {
      if (p.readyAt <= now) ready.push(p.postId)
      else pending.push(p)
    }
    cur.pendingPosts = pending
    void this.persist()
    return ready
  }
}

export const flowStateStore = new FlowStateStore()
