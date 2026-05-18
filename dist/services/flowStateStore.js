"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.flowStateStore = void 0;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const logger_1 = require("../utils/logger");
const STATE_PATH = (0, node_path_1.join)(process.cwd(), 'data', 'flow-state.json');
function defaultState() {
    return { flows: {} };
}
class FlowStateStore {
    data = defaultState();
    loaded = false;
    async load() {
        if (this.loaded)
            return;
        try {
            const raw = await (0, promises_1.readFile)(STATE_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            if (typeof parsed === 'object' && parsed !== null) {
                const o = parsed;
                if (typeof o.flows === 'object' && o.flows !== null) {
                    this.data = { flows: o.flows };
                }
            }
        }
        catch (err) {
            const code = err?.code;
            if (code !== 'ENOENT') {
                logger_1.logger.warn('flowStateStore: load failed', err);
            }
        }
        this.loaded = true;
    }
    async persist() {
        await (0, promises_1.mkdir)((0, node_path_1.dirname)(STATE_PATH), { recursive: true });
        await (0, promises_1.writeFile)(STATE_PATH, JSON.stringify(this.data, null, 2), 'utf8');
    }
    getLastMessageId(flowId) {
        return this.data.flows[flowId]?.lastMessageId ?? 0;
    }
    getCursorMeta(flowId) {
        const cur = this.data.flows[flowId];
        return {
            lastMessageId: cur?.lastMessageId ?? 0,
            updatedAt: cur?.updatedAt ?? null,
        };
    }
    async setLastMessageId(flowId, lastMessageId) {
        const cur = this.data.flows[flowId] ?? { lastMessageId: 0, pendingPosts: [] };
        cur.lastMessageId = lastMessageId;
        cur.updatedAt = new Date().toISOString();
        this.data.flows[flowId] = cur;
        await this.persist();
    }
    scheduleDelayedPost(flowId, postId, readyAt) {
        const cur = this.data.flows[flowId] ?? { lastMessageId: 0, pendingPosts: [] };
        if (!cur.pendingPosts.some((p) => p.postId === postId)) {
            cur.pendingPosts.push({ postId, readyAt });
        }
        this.data.flows[flowId] = cur;
        return this.persist();
    }
    popReadyDelayedPosts(flowId, now) {
        const cur = this.data.flows[flowId];
        if (!cur?.pendingPosts.length)
            return [];
        const ready = [];
        const pending = [];
        for (const p of cur.pendingPosts) {
            if (p.readyAt <= now)
                ready.push(p.postId);
            else
                pending.push(p);
        }
        cur.pendingPosts = pending;
        void this.persist();
        return ready;
    }
}
exports.flowStateStore = new FlowStateStore();
//# sourceMappingURL=flowStateStore.js.map