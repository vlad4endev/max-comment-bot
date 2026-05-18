"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.flowProcessor = exports.FlowProcessor = void 0;
exports.buildIntegrationsAnalytics = buildIntegrationsAnalytics;
const config_1 = require("../config");
const channelRegistry_1 = require("./channelRegistry");
const integrationPlatformClient_1 = require("./integrationPlatformClient");
const flowStateStore_1 = require("./flowStateStore");
const integrationsStore_1 = require("./integrationsStore");
const logger_1 = require("../utils/logger");
const POLL_MS = 60_000;
class FlowProcessor {
    bot = null;
    pollers = new Map();
    started = false;
    setBot(bot) {
        this.bot = bot;
    }
    async start() {
        if (this.started)
            return;
        await integrationsStore_1.integrationsStore.load();
        await flowStateStore_1.flowStateStore.load();
        const flows = integrationsStore_1.integrationsStore.getFlows().filter((f) => f.enabled);
        for (const flow of flows) {
            this.startFlowPoller(flow);
        }
        this.started = true;
        logger_1.logger.info('flowProcessor: started', { flowCount: flows.length });
    }
    async reload() {
        this.stopPollers();
        const flows = integrationsStore_1.integrationsStore.getFlows().filter((f) => f.enabled);
        for (const flow of flows) {
            this.startFlowPoller(flow);
        }
        logger_1.logger.info('flowProcessor: reloaded', { flowCount: flows.length });
    }
    startFlowPoller(flow) {
        if (this.pollers.has(flow.id))
            return;
        const interval = setInterval(() => {
            void this.processFlowSafe(flow.id);
        }, POLL_MS);
        this.pollers.set(flow.id, interval);
        void this.processFlowSafe(flow.id);
    }
    async processFlowSafe(flowId) {
        const flow = integrationsStore_1.integrationsStore.getFlow(flowId);
        if (!flow || !flow.enabled)
            return;
        try {
            await this.processFlow(flow);
        }
        catch (err) {
            logger_1.logger.error('flowProcessor: error', { flowId: flow.id, err });
            await integrationsStore_1.integrationsStore.updateFlowStats(flow.id, { incrementErrors: 1 });
        }
    }
    stopFlowPoller(flowId) {
        const t = this.pollers.get(flowId);
        if (t) {
            clearInterval(t);
            this.pollers.delete(flowId);
        }
    }
    stop() {
        this.stopPollers();
        this.started = false;
        logger_1.logger.info('flowProcessor: stopped');
    }
    stopPollers() {
        for (const timer of this.pollers.values())
            clearInterval(timer);
        this.pollers.clear();
    }
    async processFlow(flow) {
        const posts = await this.fetchNewPosts(flow);
        if (!posts.length)
            return;
        const filtered = posts.filter((p) => this.applyFilters(p, flow.filters));
        for (const post of filtered) {
            if (flow.filters.delaySeconds > 0) {
                const readyAt = Date.now() + flow.filters.delaySeconds * 1000;
                await flowStateStore_1.flowStateStore.scheduleDelayedPost(flow.id, post.externalId, readyAt);
                continue;
            }
            await this.forwardPost(flow, post);
        }
        const readyIds = flowStateStore_1.flowStateStore.popReadyDelayedPosts(flow.id, Date.now());
        for (const postId of readyIds) {
            const post = posts.find((p) => p.externalId === postId);
            if (post && this.applyFilters(post, flow.filters)) {
                await this.forwardPost(flow, post);
            }
        }
    }
    async forwardPost(flow, post) {
        await this.sendToDestination(post, flow);
        await integrationsStore_1.integrationsStore.updateFlowStats(flow.id, { incrementForwarded: 1 });
        await integrationsStore_1.integrationsStore.bumpIntegrationActivity(flow.source.integrationId);
        const fromChannel = flow.source.channelUsername ?? flow.source.channelId ?? flow.source.platform;
        const destChannel = flow.destination.channelId;
        const destTitle = channelRegistry_1.channelRegistry.getChannel(Number(destChannel))?.title ?? destChannel;
        await integrationsStore_1.integrationsStore.appendForwardedLog({
            flowId: flow.id,
            fromPlatform: flow.source.platform,
            fromChannel,
            toPlatform: flow.destination.platform,
            toChannel: destTitle ?? destChannel,
            preview: post.text.slice(0, 120) || '(без текста)',
        });
    }
    async fetchNewPosts(flow) {
        const integ = integrationsStore_1.integrationsStore.getIntegration(flow.source.integrationId);
        if (!integ || integ.status !== 'connected')
            return [];
        const cursor = flowStateStore_1.flowStateStore.getLastMessageId(flow.id);
        if (flow.source.platform === 'telegram') {
            const tgToken = (0, config_1.getTelegramToken)() || integ.token;
            if (!tgToken)
                return [];
            const channelKey = flow.source.channelId ?? flow.source.channelUsername ?? '';
            const { posts, lastMessageId } = await (0, integrationPlatformClient_1.fetchTelegramChannelPosts)(tgToken, channelKey, cursor);
            if (lastMessageId > cursor) {
                await flowStateStore_1.flowStateStore.setLastMessageId(flow.id, lastMessageId);
            }
            return posts;
        }
        if (flow.source.platform === 'vk') {
            const groupKey = flow.source.channelId ?? integ.groupId ?? '';
            const { posts, lastPostId } = await (0, integrationPlatformClient_1.fetchVkWallPosts)(integ.token, groupKey, cursor);
            if (lastPostId > cursor) {
                await flowStateStore_1.flowStateStore.setLastMessageId(flow.id, lastPostId);
            }
            return posts;
        }
        return [];
    }
    async sendToDestination(post, flow) {
        const dest = flow.destination;
        let text = post.text;
        if (dest.signature && dest.signature.trim() !== '') {
            text = text ? `${text}\n\n${dest.signature}` : dest.signature;
        }
        if (!text)
            text = ' ';
        if (dest.platform === 'max') {
            if (!this.bot) {
                throw new Error('MAX bot not initialized');
            }
            const chatId = Number(dest.channelId);
            if (!Number.isFinite(chatId)) {
                throw new Error('Invalid MAX channel id');
            }
            await this.bot.api.sendMessageToChat(chatId, text);
            return;
        }
        if (dest.platform === 'vk') {
            const integId = dest.integrationId ?? flow.source.integrationId;
            const integ = integrationsStore_1.integrationsStore.getIntegration(integId);
            if (!integ)
                throw new Error('VK integration not found');
            const groupId = dest.channelId || integ.groupId || '';
            await (0, integrationPlatformClient_1.publishVkWallPost)(integ.token, groupId, text);
            return;
        }
        if (dest.platform === 'telegram') {
            logger_1.logger.warn('flowProcessor: telegram destination not implemented yet', {
                flowId: flow.id,
            });
        }
    }
    applyFilters(post, filters) {
        const lower = post.text.toLowerCase();
        if (filters.keywords.length > 0) {
            const hasKeyword = filters.keywords.some((kw) => lower.includes(kw.toLowerCase()));
            if (!hasKeyword)
                return false;
        }
        if (filters.excludeKeywords.length > 0) {
            const hasExcluded = filters.excludeKeywords.some((kw) => lower.includes(kw.toLowerCase()));
            if (hasExcluded)
                return false;
        }
        if (filters.mediaOnly && !post.hasMedia)
            return false;
        return true;
    }
}
exports.FlowProcessor = FlowProcessor;
exports.flowProcessor = new FlowProcessor();
/** Сводная аналитика для панели */
function buildIntegrationsAnalytics() {
    const integrations = integrationsStore_1.integrationsStore.getIntegrations();
    const flows = integrationsStore_1.integrationsStore.getFlows();
    const tg = integrations.find((i) => i.platform === 'telegram' && i.status === 'connected');
    const vk = integrations.find((i) => i.platform === 'vk' && i.status === 'connected');
    const tgFlows = flows.filter((f) => f.source.platform === 'telegram');
    const vkFlows = flows.filter((f) => f.source.platform === 'vk');
    const forwardedTg = tgFlows.reduce((s, f) => s + f.stats.totalForwarded, 0);
    const forwardedVk = vkFlows.reduce((s, f) => s + f.stats.totalForwarded, 0);
    return {
        telegram: {
            connected: !!tg,
            totalPosts: tg?.stats.totalPosts ?? 0,
            forwarded: forwardedTg,
            channels: tgFlows.length,
        },
        vk: {
            connected: !!vk,
            totalPosts: vk?.stats.totalPosts ?? 0,
            forwarded: forwardedVk,
            channels: vkFlows.length,
        },
        maxChannels: channelRegistry_1.channelRegistry.getAllChannels().filter((c) => c.type === 'channel').length,
        maxTokenPreview: config_1.config.BOT_TOKEN.slice(-4),
    };
}
//# sourceMappingURL=flowProcessor.js.map