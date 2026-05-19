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
function flowPollMs() {
    return (0, config_1.getFlowPollIntervalMs)();
}
class FlowProcessor {
    bot = null;
    pollers = new Map();
    started = false;
    emptyTickCount = new Map();
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
<<<<<<< HEAD
        logger_1.logger.info('flowProcessor: started', { flowCount: flows.length });
=======
        logger_1.logger.info('flowProcessor: started', {
            flowCount: flows.length,
            pollIntervalMs: flowPollMs(),
        });
>>>>>>> origin/cursor/flow-processor-startup-fix
        if (flows.length === 0) {
            logger_1.logger.warn('flowProcessor: нет активных потоков (TG→MAX). Подключите Telegram в /admin → Интеграции и создайте поток; данные: data/integrations.json');
        }
    }
    async reload() {
        this.stopPollers();
        await integrationsStore_1.integrationsStore.reloadFromDisk();
        await flowStateStore_1.flowStateStore.load();
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
        }, flowPollMs());
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
    async runFlowOnce(flowId) {
        await integrationsStore_1.integrationsStore.load();
        await flowStateStore_1.flowStateStore.load();
        const flow = integrationsStore_1.integrationsStore.getFlow(flowId);
        if (!flow) {
            throw new Error('flow not found');
        }
        return this.processFlow(flow);
    }
    async processFlow(flow) {
        const tickStart = Date.now();
        const sourceLabel = `${flow.source.platform}:${flow.source.channelUsername ?? flow.source.channelId ?? '?'}`;
        const destLabel = `${flow.destination.platform}:${flow.destination.channelId}`;
        const { posts, lastMessageId, cursorBefore } = await this.fetchNewPosts(flow);
        logger_1.logger.info('flowProcessor: tick', {
            flowId: flow.id,
            source: sourceLabel,
            dest: destLabel,
            fetchedPosts: posts.length,
            cursorBefore,
            cursorAfter: lastMessageId,
        });
        if (!posts.length) {
            const count = (this.emptyTickCount.get(flow.id) ?? 0) + 1;
            this.emptyTickCount.set(flow.id, count);
            if (count === 5) {
                logger_1.logger.warn('flowProcessor: 5 empty ticks in a row', {
                    flowId: flow.id,
                    hint: 'Бот должен быть в канале/группе. Для канала — пост от админа; для группы — обычное сообщение. Проверьте @username/-100 ID в потоке и что у TG-бота нет webhook (deleteWebhook).',
                });
            }
            return {
                fetchedPosts: 0,
                filtered: 0,
                forwarded: 0,
                cursorBefore,
                lastMessageId,
            };
        }
        this.emptyTickCount.delete(flow.id);
        const filtered = posts.filter((p) => this.applyFilters(p, flow.filters));
        logger_1.logger.info('flowProcessor: after filters', {
            flowId: flow.id,
            total: posts.length,
            passed: filtered.length,
            dropped: posts.length - filtered.length,
        });
        let forwarded = 0;
        for (const post of filtered) {
            if (flow.filters.delaySeconds > 0) {
                const readyAt = Date.now() + flow.filters.delaySeconds * 1000;
                await flowStateStore_1.flowStateStore.scheduleDelayedPost(flow.id, post.externalId, readyAt);
                continue;
            }
            try {
                await this.forwardPost(flow, post);
                forwarded += 1;
                logger_1.logger.info('flowProcessor: forwarded', {
                    flowId: flow.id,
                    postId: post.externalId,
                    from: flow.source.channelUsername ?? flow.source.channelId,
                    to: flow.destination.channelId,
                    ms: Date.now() - tickStart,
                });
            }
            catch (err) {
                logger_1.logger.error('flowProcessor: send failed', {
                    flowId: flow.id,
                    postId: post.externalId,
                    err,
                });
                await integrationsStore_1.integrationsStore.updateFlowStats(flow.id, { incrementErrors: 1 });
            }
        }
        const readyIds = flowStateStore_1.flowStateStore.popReadyDelayedPosts(flow.id, Date.now());
        for (const postId of readyIds) {
            const post = posts.find((p) => p.externalId === postId);
            if (post && this.applyFilters(post, flow.filters)) {
                try {
                    await this.forwardPost(flow, post);
                    forwarded += 1;
                    logger_1.logger.info('flowProcessor: forwarded', {
                        flowId: flow.id,
                        postId: post.externalId,
                        from: flow.source.channelUsername ?? flow.source.channelId,
                        to: flow.destination.channelId,
                        delayed: true,
                        ms: Date.now() - tickStart,
                    });
                }
                catch (err) {
                    logger_1.logger.error('flowProcessor: send failed', {
                        flowId: flow.id,
                        postId: post.externalId,
                        err,
                    });
                    await integrationsStore_1.integrationsStore.updateFlowStats(flow.id, { incrementErrors: 1 });
                }
            }
        }
        return {
            fetchedPosts: posts.length,
            filtered: filtered.length,
            forwarded,
            cursorBefore,
            lastMessageId,
        };
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
        const cursorBefore = flowStateStore_1.flowStateStore.getLastMessageId(flow.id);
        const integ = integrationsStore_1.integrationsStore.getIntegration(flow.source.integrationId);
        if (!integ || integ.status !== 'connected') {
            return { posts: [], lastMessageId: cursorBefore, cursorBefore };
        }
        if (flow.source.platform === 'telegram') {
            const tgToken = (0, config_1.getTelegramToken)() || integ.token;
            if (!tgToken)
                return { posts: [], lastMessageId: cursorBefore, cursorBefore };
            const channelKey = flow.source.channelId ?? flow.source.channelUsername ?? '';
            const { posts, lastMessageId } = await (0, integrationPlatformClient_1.fetchTelegramChannelPosts)(tgToken, flow.source.integrationId, channelKey, cursorBefore);
            if (lastMessageId > cursorBefore) {
                await flowStateStore_1.flowStateStore.setLastMessageId(flow.id, lastMessageId);
            }
            return { posts, lastMessageId, cursorBefore };
        }
        if (flow.source.platform === 'vk') {
            const groupKey = flow.source.channelId ?? integ.groupId ?? '';
            const { posts, lastPostId } = await (0, integrationPlatformClient_1.fetchVkWallPosts)(integ.token, groupKey, cursorBefore);
            if (lastPostId > cursorBefore) {
                await flowStateStore_1.flowStateStore.setLastMessageId(flow.id, lastPostId);
            }
            return { posts, lastMessageId: lastPostId, cursorBefore };
        }
        return { posts: [], lastMessageId: cursorBefore, cursorBefore };
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