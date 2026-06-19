"use strict";
/**
 * vkPostMappingStore.ts
 *
 * Хранит маппинг: MAX message mid → VK wall post_id (и обратно).
 * Используется vkChainForwarder для синхронизации комментариев.
 *
 * Персистируется в data/vk-post-mapping.json.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.vkPostMappingStore = void 0;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const logger_1 = require("../utils/logger");
const DATA_PATH = (0, node_path_1.join)(process.cwd(), 'data', 'vk-post-mapping.json');
class VkPostMappingStore {
    data = { entries: [] };
    loaded = false;
    async load() {
        if (this.loaded)
            return;
        try {
            const raw = await (0, promises_1.readFile)(DATA_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            if (typeof parsed === 'object' && parsed !== null) {
                const o = parsed;
                this.data = {
                    entries: Array.isArray(o.entries) ? o.entries : [],
                };
            }
        }
        catch (err) {
            const code = err?.code;
            if (code !== 'ENOENT') {
                logger_1.logger.warn('vkPostMappingStore: load failed, using empty', err);
            }
        }
        this.loaded = true;
    }
    async persist() {
        await (0, promises_1.mkdir)((0, node_path_1.dirname)(DATA_PATH), { recursive: true });
        await (0, promises_1.writeFile)(DATA_PATH, JSON.stringify(this.data, null, 2), 'utf8');
    }
    async upsert(entry) {
        await this.load();
        const idx = this.data.entries.findIndex((e) => e.chainId === entry.chainId && e.maxMid === entry.maxMid);
        if (idx >= 0) {
            this.data.entries[idx] = { ...this.data.entries[idx], ...entry };
        }
        else {
            this.data.entries.push({ ...entry, createdAt: new Date().toISOString() });
        }
        await this.persist();
    }
    async updateLastCommentId(chainId, vkPostId, lastVkCommentId) {
        await this.load();
        const idx = this.data.entries.findIndex((e) => e.chainId === chainId && e.vkPostId === vkPostId);
        if (idx >= 0) {
            this.data.entries[idx].lastVkCommentId = lastVkCommentId;
            await this.persist();
        }
    }
    findByMaxMid(chainId, maxMid) {
        return this.data.entries.find((e) => e.chainId === chainId && e.maxMid === maxMid);
    }
    findByVkPostId(chainId, vkPostId) {
        return this.data.entries.find((e) => e.chainId === chainId && e.vkPostId === vkPostId);
    }
    /** Все активные записи для цепочки (для поллинга комментариев). */
    listByChain(chainId) {
        return this.data.entries.filter((e) => e.chainId === chainId);
    }
    /** Удалить записи старше N дней (чтобы файл не рос бесконечно). */
    async pruneOlderThan(days) {
        await this.load();
        const cutoff = Date.now() - days * 86_400_000;
        const before = this.data.entries.length;
        this.data.entries = this.data.entries.filter((e) => {
            const ts = new Date(e.createdAt).getTime();
            return Number.isFinite(ts) && ts > cutoff;
        });
        const pruned = before - this.data.entries.length;
        if (pruned > 0) {
            await this.persist();
        }
        return pruned;
    }
}
exports.vkPostMappingStore = new VkPostMappingStore();
//# sourceMappingURL=vkPostMappingStore.js.map