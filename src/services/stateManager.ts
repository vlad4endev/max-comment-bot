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

/**
 * Conversation state keyed by {@link chatId} then {@link userId} so users in different chats never share state.
 */
export class StateManager {
  private readonly states = new Map<number, Map<number, UserState>>()
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  /**
   * Maps MAX user id → private dialog `chat_id` where the user opened the bot (`bot_started`).
   * Used to DM the user during onboarding when `bot_added` does not include a reliable inviter.
   */
  private readonly userPrivateChatIdByUserId = new Map<number, number>()

  /**
   * Channel `chat_id` values where the bot was added but is not yet admin/owner — awaiting rights or `/connect`.
   */
  private readonly pendingAdminChannelIds = new Set<number>()

  constructor() {
    this.cleanupTimer = setInterval(() => {
      this.runCleanup()
    }, CLEANUP_INTERVAL_MS)
  }

  /**
   * Stores state for a user within a specific chat.
   */
  setState(chatId: number, userId: number, state: UserState): void {
    let inner = this.states.get(chatId)
    if (!inner) {
      inner = new Map()
      this.states.set(chatId, inner)
    }
    inner.set(userId, state)
  }

  /**
   * Returns state for a user in a chat, if any.
   */
  getState(chatId: number, userId: number): UserState | undefined {
    return this.states.get(chatId)?.get(userId)
  }

  /**
   * Deletes state for a user in a chat.
   */
  deleteState(chatId: number, userId: number): void {
    const inner = this.states.get(chatId)
    if (!inner) {
      return
    }
    inner.delete(userId)
    if (inner.size === 0) {
      this.states.delete(chatId)
    }
  }

  /**
   * Whether the user has an active state entry in the chat.
   */
  hasState(chatId: number, userId: number): boolean {
    return this.states.get(chatId)?.has(userId) ?? false
  }

  /**
   * Counts active state rows for a chat (for diagnostics / commands).
   */
  countStatesInChat(chatId: number): number {
    return this.states.get(chatId)?.size ?? 0
  }

  /**
   * Remembers the user's private chat id after `bot_started` so the bot can DM them later.
   */
  setUserPrivateChatId(userId: number, privateChatId: number): void {
    this.userPrivateChatIdByUserId.set(userId, privateChatId)
  }

  /**
   * Returns the private dialog chat id previously stored for this user, if any.
   */
  getUserPrivateChatId(userId: number): number | undefined {
    return this.userPrivateChatIdByUserId.get(userId)
  }

  /**
   * Marks a channel as waiting for admin rights (or manual `/connect` after rights are granted).
   */
  markChannelPendingAdminRights(channelChatId: number): void {
    this.pendingAdminChannelIds.add(channelChatId)
  }

  /**
   * Clears the pending-admin marker when the channel is registered or no longer relevant.
   */
  clearChannelPendingAdminRights(channelChatId: number): void {
    this.pendingAdminChannelIds.delete(channelChatId)
  }

  /**
   * Whether the channel is still waiting for admin rights / activation.
   */
  isChannelPendingAdminRights(channelChatId: number): boolean {
    return this.pendingAdminChannelIds.has(channelChatId)
  }

  /**
   * Snapshot of all channel ids pending admin-based registration (for `/connect` sweep).
   */
  getPendingAdminChannelIds(): number[] {
    return [...this.pendingAdminChannelIds]
  }

  destroy(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  private runCleanup(): void {
    const now = Date.now()
    for (const [chatId, inner] of this.states) {
      for (const [userId, state] of inner) {
        const createdAt = new Date(state.createdAt)
        if (now - createdAt.getTime() > STATE_MAX_AGE_MS) {
          inner.delete(userId)
          logger.debug('StateManager: удалено устаревшее состояние пользователя', {
            chatId,
            userId,
            mode: state.mode,
            createdAt,
          })
        }
      }
      if (inner.size === 0) {
        this.states.delete(chatId)
      }
    }
  }
}

export const stateManager = new StateManager()
