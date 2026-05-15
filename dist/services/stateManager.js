"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stateManager = exports.StateManager = void 0;
const logger_1 = require("../utils/logger");
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const STATE_MAX_AGE_MS = 30 * 60 * 1000;
/**
 * Conversation state keyed by {@link chatId} then {@link userId} so users in different chats never share state.
 */
class StateManager {
    states = new Map();
    cleanupTimer = null;
    /**
     * Maps MAX user id → private dialog `chat_id` where the user opened the bot (`bot_started`).
     * Used to DM the user during onboarding when `bot_added` does not include a reliable inviter.
     */
    userPrivateChatIdByUserId = new Map();
    /**
     * Channel `chat_id` values where the bot was added but is not yet admin/owner — awaiting rights or `/connect`.
     */
    pendingAdminChannelIds = new Set();
    constructor() {
        this.cleanupTimer = setInterval(() => {
            this.runCleanup();
        }, CLEANUP_INTERVAL_MS);
    }
    /**
     * Stores state for a user within a specific chat.
     */
    setState(chatId, userId, state) {
        let inner = this.states.get(chatId);
        if (!inner) {
            inner = new Map();
            this.states.set(chatId, inner);
        }
        inner.set(userId, state);
    }
    /**
     * Returns state for a user in a chat, if any.
     */
    getState(chatId, userId) {
        return this.states.get(chatId)?.get(userId);
    }
    /**
     * Deletes state for a user in a chat.
     */
    deleteState(chatId, userId) {
        const inner = this.states.get(chatId);
        if (!inner) {
            return;
        }
        inner.delete(userId);
        if (inner.size === 0) {
            this.states.delete(chatId);
        }
    }
    /**
     * Whether the user has an active state entry in the chat.
     */
    hasState(chatId, userId) {
        return this.states.get(chatId)?.has(userId) ?? false;
    }
    /**
     * Counts active state rows for a chat (for diagnostics / commands).
     */
    countStatesInChat(chatId) {
        return this.states.get(chatId)?.size ?? 0;
    }
    /**
     * Remembers the user's private chat id after `bot_started` so the bot can DM them later.
     */
    setUserPrivateChatId(userId, privateChatId) {
        this.userPrivateChatIdByUserId.set(userId, privateChatId);
    }
    /**
     * Returns the private dialog chat id previously stored for this user, if any.
     */
    getUserPrivateChatId(userId) {
        return this.userPrivateChatIdByUserId.get(userId);
    }
    /**
     * Marks a channel as waiting for admin rights (or manual `/connect` after rights are granted).
     */
    markChannelPendingAdminRights(channelChatId) {
        this.pendingAdminChannelIds.add(channelChatId);
    }
    /**
     * Clears the pending-admin marker when the channel is registered or no longer relevant.
     */
    clearChannelPendingAdminRights(channelChatId) {
        this.pendingAdminChannelIds.delete(channelChatId);
    }
    /**
     * Whether the channel is still waiting for admin rights / activation.
     */
    isChannelPendingAdminRights(channelChatId) {
        return this.pendingAdminChannelIds.has(channelChatId);
    }
    /**
     * Snapshot of all channel ids pending admin-based registration (for `/connect` sweep).
     */
    getPendingAdminChannelIds() {
        return [...this.pendingAdminChannelIds];
    }
    destroy() {
        if (this.cleanupTimer !== null) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }
    runCleanup() {
        const now = Date.now();
        for (const [chatId, inner] of this.states) {
            for (const [userId, state] of inner) {
                const createdAt = new Date(state.createdAt);
                if (now - createdAt.getTime() > STATE_MAX_AGE_MS) {
                    inner.delete(userId);
                    logger_1.logger.debug('StateManager: удалено устаревшее состояние пользователя', {
                        chatId,
                        userId,
                        mode: state.mode,
                        createdAt,
                    });
                }
            }
            if (inner.size === 0) {
                this.states.delete(chatId);
            }
        }
    }
}
exports.StateManager = StateManager;
exports.stateManager = new StateManager();
//# sourceMappingURL=stateManager.js.map