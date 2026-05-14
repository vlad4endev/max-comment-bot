import { logger } from '../utils/logger'

export interface UserState {
  mode: 'idle' | 'commenting' | 'replying'
  /** Если mode === 'commenting' */
  postId?: string
  /** Если mode === 'replying' */
  replyToUserId?: number
  createdAt: Date
}

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000
const STATE_MAX_AGE_MS = 30 * 60 * 1000

export class StateManager {
  private readonly states = new Map<number, UserState>()
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.cleanupTimer = setInterval(() => {
      this.runCleanup()
    }, CLEANUP_INTERVAL_MS)
  }

  setState(userId: number, state: UserState): void {
    this.states.set(userId, state)
  }

  getState(userId: number): UserState | undefined {
    return this.states.get(userId)
  }

  deleteState(userId: number): void {
    this.states.delete(userId)
  }

  hasState(userId: number): boolean {
    return this.states.has(userId)
  }

  destroy(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  private runCleanup(): void {
    const now = Date.now()
    for (const [userId, state] of this.states) {
      const createdAt = new Date(state.createdAt)
      if (now - createdAt.getTime() > STATE_MAX_AGE_MS) {
        this.states.delete(userId)
        logger.debug('StateManager: удалено устаревшее состояние пользователя', {
          userId,
          mode: state.mode,
          createdAt,
        })
      }
    }
  }
}

export const stateManager = new StateManager()
