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