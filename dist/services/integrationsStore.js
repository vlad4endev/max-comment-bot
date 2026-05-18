"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.integrationsStore = void 0;
exports.maskToken = maskToken;
exports.integrationPublicView = integrationPublicView;
const promises_1 = require("node:fs/promises");
const node_crypto_1 = require("node:crypto");
const node_path_1 = require("node:path");
const logger_1 = require("../utils/logger");
const DATA_PATH = (0, node_path_1.join)(process.cwd(), 'data', 'integrations.json');
function defaultFile() {
    return { integrations: [], flows: [], forwardedLog: [] };
}
function isIntegrationPlatform(v) {
    return v === 'telegram' || v === 'vk';
}
function isFlowPlatform(v) {
    return v === 'telegram' || v === 'vk' || v === 'max';
}
function parseFilters(raw) {
    if (typeof raw !== 'object' || raw === null)
        return null;
    const o = raw;
    const keywords = Array.isArray(o.keywords)
        ? o.keywords.filter((k) => typeof k === 'string')
        : [];
    const excludeKeywords = Array.isArray(o.excludeKeywords)
        ? o.excludeKeywords.filter((k) => typeof k === 'string')
        : [];
    const mediaOnly = o.mediaOnly === true;
    const delaySeconds = typeof o.delaySeconds === 'number' && Number.isFinite(o.delaySeconds) ? o.delaySeconds : 0;
    return { keywords, excludeKeywords, mediaOnly, delaySeconds };
}
function parseSource(raw) {
    if (typeof raw !== 'object' || raw === null)
        return null;
    const o = raw;
    if (!isFlowPlatform(o.platform) || typeof o.integrationId !== 'string')
        return null;
    return {
        integrationId: o.integrationId,
        platform: o.platform,
        channelUsername: typeof o.channelUsername === 'string' ? o.channelUsername : undefined,
        channelId: typeof o.channelId === 'string' ? o.channelId : undefined,
        contentTypes: Array.isArray(o.contentTypes)
            ? o.contentTypes.filter((c) => typeof c === 'string')
            : undefined,
    };
}
function parseDestination(raw) {
    if (typeof raw !== 'object' || raw === null)
        return null;
    const o = raw;
    if (!isFlowPlatform(o.platform) || typeof o.channelId !== 'string')
        return null;
    return {
        platform: o.platform,
        channelId: o.channelId,
        integrationId: typeof o.integrationId === 'string' ? o.integrationId : undefined,
        addCommentsButton: o.addCommentsButton === true,
        signature: typeof o.signature === 'string' ? o.signature : undefined,
    };
}
function parseFlow(raw) {
    if (typeof raw !== 'object' || raw === null)
        return null;
    const o = raw;
    if (typeof o.id !== 'string' || typeof o.name !== 'string')
        return null;
    const source = parseSource(o.source);
    const destination = parseDestination(o.destination);
    const filters = parseFilters(o.filters);
    if (!source || !destination || !filters)
        return null;
    const statsRaw = o.stats;
    const stats = {
        totalForwarded: typeof statsRaw?.totalForwarded === 'number' ? statsRaw.totalForwarded : 0,
        lastForwardedAt: typeof statsRaw?.lastForwardedAt === 'string' ? statsRaw.lastForwardedAt : null,
        errors: typeof statsRaw?.errors === 'number' ? statsRaw.errors : 0,
    };
    return {
        id: o.id,
        name: o.name,
        enabled: o.enabled !== false,
        source,
        filters,
        destination,
        stats,
        createdAt: typeof o.createdAt === 'string' ? o.createdAt : new Date().toISOString(),
    };
}
function parseLinkedChat(raw) {
    if (typeof raw !== 'object' || raw === null)
        return null;
    const o = raw;
    if (typeof o.id !== 'string' || typeof o.title !== 'string')
        return null;
    return {
        id: o.id,
        title: o.title,
        username: typeof o.username === 'string' ? o.username : undefined,
        type: typeof o.type === 'string' ? o.type : undefined,
        botIsAdmin: o.botIsAdmin === true,
    };
}
function parseIntegration(raw) {
    if (typeof raw !== 'object' || raw === null)
        return null;
    const o = raw;
    if (typeof o.id !== 'string' || !isIntegrationPlatform(o.platform))
        return null;
    if (typeof o.name !== 'string' || typeof o.token !== 'string')
        return null;
    const statsRaw = o.stats;
    const linkedChats = Array.isArray(o.linkedChats)
        ? o.linkedChats.map(parseLinkedChat).filter((x) => x !== null)
        : undefined;
    return {
        id: o.id,
        platform: o.platform,
        name: o.name,
        token: o.token,
        groupId: typeof o.groupId === 'string' ? o.groupId : undefined,
        status: o.status === 'connected' || o.status === 'disconnected' || o.status === 'error'
            ? o.status
            : 'disconnected',
        connectedAt: typeof o.connectedAt === 'string' ? o.connectedAt : new Date().toISOString(),
        stats: {
            totalPosts: typeof statsRaw?.totalPosts === 'number' ? statsRaw.totalPosts : 0,
            lastActivity: typeof statsRaw?.lastActivity === 'string' ? statsRaw.lastActivity : null,
        },
        linkedChats: linkedChats?.length ? linkedChats : undefined,
        linkedChatsUpdatedAt: typeof o.linkedChatsUpdatedAt === 'string' ? o.linkedChatsUpdatedAt : undefined,
    };
}
class IntegrationsStore {
    data = defaultFile();
    loaded = false;
    async load() {
        if (this.loaded)
            return;
        try {
            const raw = await (0, promises_1.readFile)(DATA_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            if (typeof parsed === 'object' && parsed !== null) {
                const o = parsed;
                const integrations = Array.isArray(o.integrations)
                    ? o.integrations.map(parseIntegration).filter((x) => x !== null)
                    : [];
                const flows = Array.isArray(o.flows)
                    ? o.flows.map(parseFlow).filter((x) => x !== null)
                    : [];
                const forwardedLog = Array.isArray(o.forwardedLog)
                    ? o.forwardedLog.filter((e) => {
                        if (typeof e !== 'object' || e === null)
                            return false;
                        const x = e;
                        return (typeof x.id === 'string' &&
                            typeof x.flowId === 'string' &&
                            typeof x.forwardedAt === 'string');
                    })
                    : [];
                this.data = { integrations, flows, forwardedLog };
            }
        }
        catch (err) {
            const code = err?.code;
            if (code !== 'ENOENT') {
                logger_1.logger.warn('integrationsStore: load failed, using empty', err);
            }
        }
        this.loaded = true;
    }
    async persist() {
        await (0, promises_1.mkdir)((0, node_path_1.dirname)(DATA_PATH), { recursive: true });
        await (0, promises_1.writeFile)(DATA_PATH, JSON.stringify(this.data, null, 2), 'utf8');
    }
    getIntegrations() {
        return [...this.data.integrations];
    }
    getIntegration(id) {
        return this.data.integrations.find((i) => i.id === id);
    }
    async upsertIntegration(input) {
        const now = new Date().toISOString();
        const existing = input.id ? this.getIntegration(input.id) : undefined;
        const record = existing
            ? {
                ...existing,
                platform: input.platform,
                name: input.name,
                token: input.token,
                groupId: input.groupId,
                status: input.status,
                stats: input.stats ?? existing.stats,
            }
            : {
                id: input.id ?? `int_${input.platform}_${(0, node_crypto_1.randomUUID)().slice(0, 8)}`,
                platform: input.platform,
                name: input.name,
                token: input.token,
                groupId: input.groupId,
                status: input.status,
                connectedAt: input.connectedAt ?? now,
                stats: input.stats ?? { totalPosts: 0, lastActivity: null },
            };
        if (existing) {
            this.data.integrations = this.data.integrations.map((i) => i.id === record.id ? record : i);
        }
        else {
            this.data.integrations.push(record);
        }
        await this.persist();
        return record;
    }
    async deleteIntegration(id) {
        const before = this.data.integrations.length;
        this.data.integrations = this.data.integrations.filter((i) => i.id !== id);
        this.data.flows = this.data.flows.filter((f) => f.source.integrationId !== id && f.destination.integrationId !== id);
        if (this.data.integrations.length === before)
            return false;
        await this.persist();
        return true;
    }
    getFlows() {
        return [...this.data.flows];
    }
    getFlow(id) {
        return this.data.flows.find((f) => f.id === id);
    }
    async saveFlow(flow) {
        const idx = this.data.flows.findIndex((f) => f.id === flow.id);
        if (idx >= 0) {
            this.data.flows[idx] = flow;
        }
        else {
            this.data.flows.push(flow);
        }
        await this.persist();
    }
    async deleteFlow(id) {
        const before = this.data.flows.length;
        this.data.flows = this.data.flows.filter((f) => f.id !== id);
        if (before === this.data.flows.length)
            return false;
        await this.persist();
        return true;
    }
    async updateFlowStats(id, patch) {
        const flow = this.getFlow(id);
        if (!flow)
            return;
        const stats = { ...flow.stats };
        if (patch.incrementForwarded) {
            stats.totalForwarded += patch.incrementForwarded;
            stats.lastForwardedAt = new Date().toISOString();
        }
        if (patch.incrementErrors) {
            stats.errors += patch.incrementErrors;
        }
        if (patch.totalForwarded !== undefined)
            stats.totalForwarded = patch.totalForwarded;
        if (patch.lastForwardedAt !== undefined)
            stats.lastForwardedAt = patch.lastForwardedAt;
        if (patch.errors !== undefined)
            stats.errors = patch.errors;
        await this.saveFlow({ ...flow, stats });
    }
    async appendForwardedLog(entry) {
        this.data.forwardedLog.unshift({
            ...entry,
            id: (0, node_crypto_1.randomUUID)(),
            forwardedAt: new Date().toISOString(),
        });
        if (this.data.forwardedLog.length > 500) {
            this.data.forwardedLog = this.data.forwardedLog.slice(0, 500);
        }
        await this.persist();
    }
    getForwardedLog(limit, flowId) {
        let list = this.data.forwardedLog;
        if (flowId) {
            list = list.filter((e) => e.flowId === flowId);
        }
        return list.slice(0, limit);
    }
    async setLinkedChats(integrationId, chats) {
        const integ = this.getIntegration(integrationId);
        if (!integ)
            return undefined;
        const linkedChats = chats.map((c) => ({
            id: c.id,
            title: c.title,
            username: c.username,
            type: c.type,
            botIsAdmin: c.botIsAdmin === true,
        }));
        const record = {
            ...integ,
            linkedChats,
            linkedChatsUpdatedAt: new Date().toISOString(),
        };
        this.data.integrations = this.data.integrations.map((i) => i.id === record.id ? record : i);
        await this.persist();
        return record;
    }
    getTelegramIntegration() {
        return this.data.integrations.find((i) => i.platform === 'telegram' && i.status === 'connected');
    }
    async bumpIntegrationActivity(integrationId, posts = 1) {
        const integ = this.getIntegration(integrationId);
        if (!integ)
            return;
        await this.upsertIntegration({
            ...integ,
            stats: {
                totalPosts: integ.stats.totalPosts + posts,
                lastActivity: new Date().toISOString(),
            },
        });
    }
}
exports.integrationsStore = new IntegrationsStore();
function maskToken(token) {
    if (token.length <= 4)
        return '••••';
    return `••••••••${token.slice(-4)}`;
}
function integrationPublicView(i) {
    return {
        id: i.id,
        platform: i.platform,
        name: i.name,
        groupId: i.groupId ?? null,
        status: i.status,
        connectedAt: i.connectedAt,
        stats: i.stats,
        tokenPreview: maskToken(i.token),
        linkedChats: i.linkedChats ?? [],
        linkedChatsUpdatedAt: i.linkedChatsUpdatedAt ?? null,
    };
}
//# sourceMappingURL=integrationsStore.js.map