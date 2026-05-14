"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stateManager = exports.StateManager = void 0;
const logger_1 = require("../utils/logger");
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const STATE_MAX_AGE_MS = 30 * 60 * 1000;
class StateManager {
    states = new Map();
    cleanupTimer = null;
    constructor() {
        this.cleanupTimer = setInterval(() => {
            this.runCleanup();
        }, CLEANUP_INTERVAL_MS);
    }
    setState(userId, state) {
        this.states.set(userId, state);
    }
    getState(userId) {
        return this.states.get(userId);
    }
    deleteState(userId) {
        this.states.delete(userId);
    }
    hasState(userId) {
        return this.states.has(userId);
    }
    destroy() {
        if (this.cleanupTimer !== null) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }
    runCleanup() {
        const now = Date.now();
        for (const [userId, state] of this.states) {
            const createdAt = new Date(state.createdAt);
            if (now - createdAt.getTime() > STATE_MAX_AGE_MS) {
                this.states.delete(userId);
                logger_1.logger.debug('StateManager: удалено устаревшее состояние пользователя', {
                    userId,
                    mode: state.mode,
                    createdAt,
                });
            }
        }
    }
}
exports.StateManager = StateManager;
exports.stateManager = new StateManager();
//# sourceMappingURL=stateManager.js.map