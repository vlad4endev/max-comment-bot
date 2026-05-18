import type { Bot } from '@maxhub/max-bot-api';
import { type FlowRecord } from './integrationsStore';
export interface FlowTickResult {
    fetchedPosts: number;
    filtered: number;
    forwarded: number;
    cursorBefore: number;
    lastMessageId: number;
}
export declare class FlowProcessor {
    private bot;
    private pollers;
    private started;
    private emptyTickCount;
    setBot(bot: Bot): void;
    start(): Promise<void>;
    reload(): Promise<void>;
    startFlowPoller(flow: FlowRecord): void;
    private processFlowSafe;
    stopFlowPoller(flowId: string): void;
    stop(): void;
    private stopPollers;
    runFlowOnce(flowId: string): Promise<FlowTickResult>;
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
