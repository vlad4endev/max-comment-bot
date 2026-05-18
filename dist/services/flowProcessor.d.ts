import type { Bot } from '@maxhub/max-bot-api';
import { type FlowRecord } from './integrationsStore';
export declare class FlowProcessor {
    private bot;
    private pollers;
    private started;
    setBot(bot: Bot): void;
    start(): Promise<void>;
    reload(): Promise<void>;
    startFlowPoller(flow: FlowRecord): void;
    private processFlowSafe;
    stopFlowPoller(flowId: string): void;
    stop(): void;
    private stopPollers;
    private processFlow;
    private forwardPost;
    private fetchNewPosts;
    private sendToDestination;
    private applyFilters;
}
export declare const flowProcessor: FlowProcessor;
/** Сводная аналитика для панели */
export declare function buildIntegrationsAnalytics(): {
    telegram: {
        connected: boolean;
        totalPosts: number;
        forwarded: number;
        channels: number;
    };
    vk: {
        connected: boolean;
        totalPosts: number;
        forwarded: number;
        channels: number;
    };
    maxChannels: number;
    maxTokenPreview: string;
};
